import { z } from "zod";
import { createHash } from "node:crypto";
import type { DomainSpec } from "../registry";
import { DeviceSession } from "../runtime/device";
import type { ActionElement } from "../models";
import { parseSelectorArgs, parseBoundsRect } from "../selectors/parser";
import { resolveSelector, rectOverlapRatio, OVERLAP_MERGE } from "../selectors/resolver";
import { SelectorNotFoundError, TimeoutError, UsageError } from "../errors";
import { DaemonClient } from "../daemon/client";

const ACTIONABLE_CLASSES = new Set([
  "android.widget.Button",
  "android.widget.ImageButton",
  "android.widget.CheckBox",
  "android.widget.RadioButton",
  "android.widget.Switch",
  "android.widget.EditText",
  "Button",
  "ImageButton",
  "CheckBox",
  "RadioButton",
  "Switch",
  "EditText",
]);

const DEFAULT_FILTER_PACKAGES = new Set([
  "com.android.systemui",
  "com.google.android.inputmethod.latin",
  "com.samsung.android.honeyboard",
  "com.swiftkey.swiftkeyapp",
  "com.baidu.input",
  "com.iflytek.inputmethod",
]);

export function computeScreenFingerprint(elements: ActionElement[]): string {
  const tuples = elements.map(
    (e) => `${e.resourceId}:${e.text}:${e.contentDesc}:${e.className}:${e.bounds}`
  );
  tuples.sort();
  const raw = tuples.join("|");
  return createHash("sha256").update(raw, "utf-8").digest("hex").slice(0, 16);
}

const STRUCTURAL_CLASSES = new Set([
  "android.widget.FrameLayout",
  "android.widget.LinearLayout",
  "android.widget.RelativeLayout",
  "androidx.recyclerview.widget.RecyclerView",
  "androidx.recyclerview.widget.StaggeredGridLayoutManager",
  "android.view.ViewGroup",
  "android.view.View",
  "FrameLayout",
  "LinearLayout",
  "RelativeLayout",
  "RecyclerView",
  "StaggeredGridLayoutManager",
  "ViewGroup",
]);

export function getSemanticRole(el: ActionElement): string {
  const cls = el.className || "";
  const resId = (el.resourceId || "").toLowerCase();
  const text = el.text || el.contentDesc || "";
  
  if (cls.endsWith("EditText")) return "Input";
  if (cls.endsWith("Switch") || cls.endsWith("CheckBox") || cls.endsWith("RadioButton")) return "Toggle";
  if (cls.includes("Tab") || resId.includes("tab") || (text.length <= 20 && text.toLowerCase().includes("tab"))) return "Tab";
  if (cls.endsWith("Button") || cls.endsWith("ImageButton")) return "Button";
  if (cls.endsWith("TextView")) {
    return el.clickable ? "Button" : "Text";
  }
  if (el.clickable) return "Button";
  return text ? "Item" : "Element";
}

export function deduplicateAndFilterElements(elements: ActionElement[]): ActionElement[] {
  const filtered = elements.filter((el) => {
    const hasText = Boolean((el.text && el.text.trim()) || (el.contentDesc && el.contentDesc.trim()));
    if (!hasText) {
      const clsName = el.className || "";
      if (STRUCTURAL_CLASSES.has(clsName) || clsName.endsWith("Manager") || clsName.endsWith("Layout")) {
        return false;
      }
    }
    return true;
  });

  const elementRects = filtered.map((el) => parseBoundsRect(el.bounds));
  const result: ActionElement[] = [];
  const resultRects: (ReturnType<typeof parseBoundsRect>)[] = [];

  const CELL_SIZE = 150;
  const grid = new Map<string, number[]>();

  const getCellKeys = (rect: ReturnType<typeof parseBoundsRect>) => {
    if (!rect) return [];
    const minX = Math.floor(rect.x1 / CELL_SIZE);
    const maxX = Math.floor(rect.x2 / CELL_SIZE);
    const minY = Math.floor(rect.y1 / CELL_SIZE);
    const maxY = Math.floor(rect.y2 / CELL_SIZE);
    const keys: string[] = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        keys.push(`${x},${y}`);
      }
    }
    return keys;
  };

  for (let idx = 0; idx < filtered.length; idx++) {
    const current = filtered[idx];
    const currentRect = elementRects[idx];
    if (!currentRect) {
      result.push(current);
      resultRects.push(null);
      continue;
    }

    const cellKeys = getCellKeys(currentRect);
    const candidateIndices = new Set<number>();
    for (const key of cellKeys) {
      const existingInCell = grid.get(key);
      if (existingInCell) {
        for (const i of existingInCell) candidateIndices.add(i);
      }
    }

    let merged = false;
    for (const i of candidateIndices) {
      const existingRect = resultRects[i];
      if (!existingRect) continue;

      const area1 = (currentRect.x2 - currentRect.x1) * (currentRect.y2 - currentRect.y1);
      const area2 = (existingRect.x2 - existingRect.x1) * (existingRect.y2 - existingRect.y1);
      const minArea = Math.min(area1, area2);
      const maxArea = Math.max(area1, area2);
      const sizeRatio = maxArea / Math.max(minArea, 1);

      // Do not merge elements of vastly different sizes (e.g. child inside container/card)
      if (sizeRatio > 2.5) {
        continue;
      }

      const existing = result[i];
      const existingText = (existing.text || existing.contentDesc || "").trim();
      const currentText = (current.text || current.contentDesc || "").trim();

      // Never merge two elements with distinct non-empty labels
      if (existingText && currentText && existingText !== currentText) {
        continue;
      }

      const overlap = rectOverlapRatio(currentRect, existingRect);
      if (overlap >= OVERLAP_MERGE) {
        const existingHasText = Boolean(existingText);
        const currentHasText = Boolean(currentText);

        if (!existingHasText && currentHasText) {
          result[i] = {
            ...current,
            index: existing.index,
            ref: existing.ref,
            clickable: existing.clickable || current.clickable,
            focused: existing.focused || current.focused,
          };
          resultRects[i] = currentRect;
        } else {
          result[i] = {
            ...existing,
            clickable: existing.clickable || current.clickable,
            focused: existing.focused || current.focused,
          };
        }
        merged = true;
        break;
      }
    }

    if (!merged) {
      const newIndex = result.length;
      result.push(current);
      resultRects.push(currentRect);
      for (const key of cellKeys) {
        let cell = grid.get(key);
        if (!cell) {
          cell = [];
          grid.set(key, cell);
        }
        cell.push(newIndex);
      }
    }
  }

  return result.map((el, idx) => ({
    ...el,
    index: idx,
    ref: `@${idx + 1}`,
  }));
}

export function sortByRelevance(
  elements: ActionElement[],
  screenWidth: number = 1080,
  screenHeight: number = 2340
): ActionElement[] {
  const centerX = screenWidth / 2;
  const centerY = screenHeight / 2;

  const sorted = [...elements].sort((a, b) => {
    // 1. Focused element first
    if (a.focused && !b.focused) return -1;
    if (!a.focused && b.focused) return 1;

    // 2. Clickable with non-empty text or contentDesc
    const aText = Boolean((a.text && a.text.trim()) || (a.contentDesc && a.contentDesc.trim()));
    const bText = Boolean((b.text && b.text.trim()) || (b.contentDesc && b.contentDesc.trim()));
    const aActionable = a.clickable && aText;
    const bActionable = b.clickable && bText;
    if (aActionable && !bActionable) return -1;
    if (!aActionable && bActionable) return 1;

    // 3. Distance to screen center
    const rectA = parseBoundsRect(a.bounds);
    const rectB = parseBoundsRect(b.bounds);
    if (rectA && rectB) {
      const distA = Math.hypot((rectA.x1 + rectA.x2) / 2 - centerX, (rectA.y1 + rectA.y2) / 2 - centerY);
      const distB = Math.hypot((rectB.x1 + rectB.x2) / 2 - centerX, (rectB.y1 + rectB.y2) / 2 - centerY);
      if (Math.abs(distA - distB) > 10) {
        return distA - distB;
      }
    }

    return (a.index ?? 0) - (b.index ?? 0);
  });

  return sorted.map((el, idx) => ({
    ...el,
    index: idx,
    ref: `@${idx + 1}`,
  }));
}

export function formatCompactSnapshot(
  elements: ActionElement[],
  packageName?: string,
  fingerprint?: string,
  changed?: boolean,
  totalCount?: number
): string {
  let header = `[App: ${packageName || "active"}`;
  if (changed !== undefined) {
    header += ` | changed: ${changed ? "yes" : "no"}`;
  } else if (fingerprint) {
    header += ` | fingerprint: ${fingerprint}`;
  }
  header += `]`;

  const lines = elements.map((e) => {
    const ref = e.ref || `@${e.index + 1}`;
    const role = getSemanticRole(e);
    const label = e.text || e.contentDesc || "";
    const labelStr = label ? ` "${label}"` : "";
    const stateFlags: string[] = [];
    if (e.focused) stateFlags.push("focused");
    const stateStr = stateFlags.length > 0 ? ` [${stateFlags.join(", ")}]` : "";
    return `[${ref}] ${role}${labelStr}${stateStr}`;
  });

  if (totalCount !== undefined && totalCount > elements.length) {
    lines.push(`... (${totalCount - elements.length} more elements truncated, use --limit to expand)`);
  }

  return [header, ...lines].join("\n");
}

function decodeXmlEntities(str: string): string {
  if (!str) return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const ATTR_REGEX_CACHE = new Map<string, RegExp>();
function getAttrRegex(key: string): RegExp {
  let re = ATTR_REGEX_CACHE.get(key);
  if (!re) {
    re = new RegExp(`${key}="([^"]*)"`);
    ATTR_REGEX_CACHE.set(key, re);
  }
  return re;
}

export function parseXmlDump(
  xmlContent: string,
  includeSystemBars: boolean = false,
  dedupe: boolean = true
): ActionElement[] {
  const elements: ActionElement[] = [];
  if (!xmlContent) return elements;

  const nodeRegex = /<node\s+([^>]+)\/?>/g;
  let match: RegExpExecArray | null;

  let indexCounter = 0;

  while ((match = nodeRegex.exec(xmlContent)) !== null) {
    const attrStr = match[1];
    const getAttr = (key: string) => {
      const m = attrStr.match(getAttrRegex(key));
      return m ? decodeXmlEntities(m[1]) : "";
    };

    const resId = getAttr("resource-id");
    const pkgName = getAttr("package");
    const text = getAttr("text");
    const desc = getAttr("content-desc");
    const clsName = getAttr("class");
    const bounds = getAttr("bounds");

    if (!bounds) continue;

    const clickable = getAttr("clickable") === "true";
    const scrollable = getAttr("scrollable") === "true";
    const checkable = getAttr("checkable") === "true";
    const focused = getAttr("focused") === "true";
    const focusable = getAttr("focusable") === "true";
    const editable = focusable && clsName.endsWith("EditText");

    if (!includeSystemBars) {
      if (
        DEFAULT_FILTER_PACKAGES.has(pkgName) ||
        resId.startsWith("com.android.systemui") ||
        Array.from(DEFAULT_FILTER_PACKAGES).some((p) => resId.startsWith(`${p}:`))
      ) {
        continue;
      }
    }

    const isActionable =
      clickable ||
      scrollable ||
      checkable ||
      focused ||
      editable ||
      ACTIONABLE_CLASSES.has(clsName) ||
      (text.length > 0 && text.length <= 200) ||
      (desc.length > 0 && desc.length <= 200);

    if (!isActionable) continue;

    const nextIndex = indexCounter++;
    elements.push({
      index: nextIndex,
      ref: `@${nextIndex + 1}`,
      text,
      resourceId: resId,
      contentDesc: desc,
      className: clsName,
      bounds,
      clickable,
      scrollable,
      focused,
      visible_to_selector_engine: true,
    });
  }

  if (!dedupe) {
    return elements;
  }

  return deduplicateAndFilterElements(elements);
}

export function checkExpect(
  args: Record<string, unknown>,
  postElements: ActionElement[]
): [boolean, Record<string, unknown> | null] {
  const expectDescContains = args.expect_desc_contains as string | undefined;
  const expectTextContains = args.expect_text_contains as string | undefined;
  const expectElementAbsent = Boolean(args.expect_element_absent);

  if (expectElementAbsent) {
    let sel: Record<string, unknown> = {};
    if (expectDescContains) {
      sel.desc_contains = expectDescContains;
    } else if (expectTextContains) {
      sel.text_contains = expectTextContains;
    } else {
      sel = args;
    }

    try {
      const query = parseSelectorArgs(sel);
      const match = resolveSelector(postElements, query);
      return [false, match.element as unknown as Record<string, unknown>];
    } catch {
      return [true, null];
    }
  }

  const sel: Record<string, unknown> = {};
  if (expectDescContains) sel.desc_contains = expectDescContains;
  if (expectTextContains) sel.text_contains = expectTextContains;

  if (Object.keys(sel).length === 0) {
    return [true, null];
  }

  try {
    const query = parseSelectorArgs(sel);
    const match = resolveSelector(postElements, query);
    return [true, match.element as unknown as Record<string, unknown>];
  } catch {
    return [false, null];
  }
}

export const UI_DOMAIN: DomainSpec = {
  name: "ui",
  description: "UI hierarchy projection, semantic selector interaction, gestures, and text input",
  tools: [
    {
      name: "ui.snapshot",
      domain: "ui",
      description: "Dump ultra-compact semantic UI snapshot with element handles (@1, @2, ...) optimized for LLMs",
      inputSchema: z.object({
        limit: z.number().optional().default(30),
        include_system_bars: z.boolean().optional().default(false),
        include_handles: z.boolean().optional().default(false),
        use_daemon: z.boolean().optional().default(true),
        diff: z.boolean().optional().default(false),
        fingerprint: z.boolean().optional().default(false),
      }),
      outputSchema: z.object({
        screen_fingerprint: z.string(),
        element_count: z.number(),
        raw_count: z.number().optional(),
        snapshot: z.string(),
        handles: z.record(z.unknown()).optional(),
      }),
      safety: "read",
      handler: async (ctx, args) => {
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.snapshot(args);
            ctx.serial = daemonClient.serial || ctx.serial;
            return {
              screen_fingerprint: daemonRes.screen_fingerprint,
              element_count: daemonRes.element_count,
              raw_count: daemonRes.raw_count,
              snapshot: daemonRes.snapshot,
              ...(daemonRes.handles ? { handles: daemonRes.handles } : {}),
            };
          } catch (e: any) {
            ctx.warn(`Daemon snapshot failed, falling back to direct RPC: ${e.message}`);
          }
        }

        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        let packageName: string | undefined = undefined;
        try {
          const info = await client.deviceInfo();
          packageName = info.currentPackageName;
        } catch {}

        const xml = await client.dumpHierarchy(true);
        const rawElements = parseXmlDump(xml, args.include_system_bars, false);
        const rawCount = rawElements.length;
        let elements = deduplicateAndFilterElements(rawElements);
        const totalCount = elements.length;
        if (args.limit > 0 && elements.length > args.limit) {
          elements = sortByRelevance(elements).slice(0, args.limit);
        }

        const fp = computeScreenFingerprint(elements);
        const snapshotText = formatCompactSnapshot(
          elements,
          packageName,
          args.fingerprint ? fp : undefined,
          undefined,
          totalCount
        );

        const handlesObj: Record<string, unknown> = {};
        if (args.include_handles) {
          elements.forEach((el) => {
            if (el.ref) {
              handlesObj[el.ref] = { text: el.text, resourceId: el.resourceId, bounds: el.bounds };
            }
          });
        }

        return {
          screen_fingerprint: fp,
          element_count: elements.length,
          raw_count: rawCount,
          snapshot: snapshotText,
          ...(args.include_handles ? { handles: handlesObj } : {}),
        };
      },
    },
    {
      name: "ui.dump",
      domain: "ui",
      description: "Dump UI hierarchy and actionable elements with screen fingerprint",
      inputSchema: z.object({
        filter: z.enum(["actionable", "all"]).optional().default("actionable"),
        limit: z.number().optional().default(30),
        include_system_bars: z.boolean().optional().default(false),
        raw: z.boolean().optional().default(false),
      }),
      outputSchema: z.object({
        screen_fingerprint: z.string(),
        element_count: z.number(),
        raw_count: z.number().optional(),
        elements: z.array(z.record(z.unknown())),
        raw_xml: z.string().optional(),
      }),
      safety: "read",
      handler: async (ctx, args) => {
        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        const xml = await client.dumpHierarchy(true);
        const dedupe = args.filter !== "all";
        const rawElements = parseXmlDump(xml, args.include_system_bars, false);
        const rawCount = rawElements.length;
        let elements = dedupe ? deduplicateAndFilterElements(rawElements) : rawElements;

        if (args.limit > 0 && elements.length > args.limit) {
          elements = sortByRelevance(elements).slice(0, args.limit);
        }

        const fingerprint = computeScreenFingerprint(elements);

        return {
          screen_fingerprint: fingerprint,
          element_count: elements.length,
          raw_count: rawCount,
          elements: elements as unknown as Record<string, unknown>[],
          ...(args.raw ? { raw_xml: xml } : {}),
        };
      },
    },
    {
      name: "ui.tap",
      domain: "ui",
      description: "Tap visible UI element matching selector or bounds coordinates",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element handle from ui.snapshot (e.g. @1, @2)"),
        pos: z.string().optional().describe("Direct tap coordinates 'X,Y' (bypasses selector resolution)"),
        text: z.string().optional(),
        text_contains: z.string().optional(),
        resource_id: z.string().optional(),
        description: z.string().optional(),
        desc_contains: z.string().optional(),
        class_name: z.string().optional(),
        bounds: z.string().optional(),
        expect_desc_contains: z.string().optional(),
        expect_text_contains: z.string().optional(),
        expect_element_absent: z.boolean().optional(),
        use_daemon: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        tapped: z.boolean(),
        x: z.number(),
        y: z.number(),
        postcondition: z.record(z.unknown()).optional(),
      }),
      safety: "interactive",
      expect: {
        schema: z.object({ tapped: z.literal(true) }),
      },
      handler: async (ctx, args) => {
        const hasExpect = Boolean(args.expect_desc_contains || args.expect_text_contains || args.expect_element_absent);
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.action("tap", args);
            ctx.serial = daemonClient.serial || ctx.serial;
            if (daemonRes.ok) {
              return daemonRes.result;
            }
          } catch (e: any) {
            ctx.warn(`Daemon tap action failed, falling back to direct RPC: ${e.message}`);
          }
        }

        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        let targetX = 0;
        let targetY = 0;
        let preFingerprint = "";

        if (args.pos) {
          const parts = args.pos.replace(/\s+/g, "").split(",").map(Number);
          if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
            throw new UsageError(`Invalid --pos coordinates '${args.pos}'. Expected 'X,Y' format.`);
          }
          targetX = parts[0];
          targetY = parts[1];
          if (hasExpect) {
            const xml = await client.dumpHierarchy(true);
            const elements = parseXmlDump(xml, true);
            preFingerprint = computeScreenFingerprint(elements);
          }
        } else {
          const xml = await client.dumpHierarchy(true);
          const rawElements = parseXmlDump(xml, true, false);
          const elements = deduplicateAndFilterElements(rawElements);
          preFingerprint = computeScreenFingerprint(elements);

          const query = parseSelectorArgs(args as Record<string, unknown>);
          const matched = resolveSelector(elements, query, false, rawElements);

          if (matched.warnings.length > 0) {
            for (const w of matched.warnings) ctx.warn(w);
          }
          targetX = matched.centerX;
          targetY = matched.centerY;
        }

        await client.click(targetX, targetY);

        const postcondition: Record<string, unknown> = {};

        if (hasExpect) {
          const postXml = await client.dumpHierarchy(true);
          const postElements = parseXmlDump(postXml, true);
          const postFingerprint = computeScreenFingerprint(postElements);
          postcondition.screen_changed = preFingerprint !== postFingerprint;
          postcondition.screen_fingerprint = postFingerprint;

          const [satisfied, matchedElem] = checkExpect(args as Record<string, unknown>, postElements);
          postcondition.expect_satisfied = satisfied;
          if (matchedElem) postcondition.matched_element = matchedElem;
        }

        return {
          tapped: true,
          x: targetX,
          y: targetY,
          ...(hasExpect ? { postcondition } : {}),
        };
      },
    },
    {
      name: "ui.long_press",
      domain: "ui",
      description: "Long-press one visible UI element matched by selector",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element handle from ui.snapshot (e.g. @1, @2)"),
        text: z.string().optional(),
        text_contains: z.string().optional(),
        resource_id: z.string().optional(),
        description: z.string().optional(),
        desc_contains: z.string().optional(),
        bounds: z.string().optional(),
        duration: z.number().optional().default(1.0),
        expect_desc_contains: z.string().optional(),
        expect_text_contains: z.string().optional(),
        expect_element_absent: z.boolean().optional(),
        use_daemon: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        duration: z.number(),
        postcondition: z.record(z.unknown()),
        element: z.record(z.unknown()).optional(),
        bounds: z.string().optional(),
      }),
      safety: "interactive",
      expect: {
        schema: z.object({ postcondition: z.record(z.unknown()) }),
      },
      handler: async (ctx, args) => {
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.action("long_press", args);
            ctx.serial = daemonClient.serial || ctx.serial;
            if (daemonRes.ok) return daemonRes.result;
          } catch (e: any) {
            ctx.warn(`Daemon long_press action failed, falling back to direct RPC: ${e.message}`);
          }
        }

        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        const xml = await client.dumpHierarchy(true);
        const rawElements = parseXmlDump(xml, true, false);
        const elements = deduplicateAndFilterElements(rawElements);
        const preFingerprint = computeScreenFingerprint(elements);

        const query = parseSelectorArgs(args as Record<string, unknown>);
        const matched = resolveSelector(elements, query, false, rawElements);

        if (matched.warnings.length > 0) {
          for (const w of matched.warnings) ctx.warn(w);
        }

        const duration = args.duration ?? 1.0;
        await client.longClick(matched.centerX, matched.centerY, duration);

        const postXml = await client.dumpHierarchy(true);
        const postElements = parseXmlDump(postXml, true);
        const postFingerprint = computeScreenFingerprint(postElements);

        const postcondition: Record<string, unknown> = {
          screen_changed: preFingerprint !== postFingerprint,
          screen_fingerprint: postFingerprint,
        };

        const hasExpect = Boolean(args.expect_desc_contains || args.expect_text_contains || args.expect_element_absent);
        if (hasExpect) {
          const [satisfied, matchedElem] = checkExpect(args as Record<string, unknown>, postElements);
          postcondition.expect_satisfied = satisfied;
          if (matchedElem) postcondition.matched_element = matchedElem;
        }

        return {
          duration,
          postcondition,
          element: matched.element as unknown as Record<string, unknown>,
          bounds: matched.element.bounds,
        };
      },
    },
    {
      name: "ui.input",
      domain: "ui",
      description: "Send text input to currently focused field or target element",
      inputSchema: z.object({
        text: z.string().describe("Text string to input"),
        clear_first: z.boolean().optional().default(false),
        use_daemon: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        text: z.string(),
        success: z.boolean(),
        text_typed: z.string().optional(),
        input_method: z.string().optional(),
        postcondition: z.record(z.unknown()).optional(),
      }),
      safety: "interactive",
      expect: {
        schema: z.object({ success: z.literal(true) }),
      },
      handler: async (ctx, args) => {
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.action("input", args);
            ctx.serial = daemonClient.serial || ctx.serial;
            if (daemonRes.ok) return daemonRes.result;
          } catch (e: any) {
            ctx.warn(`Daemon input action failed, falling back to direct RPC: ${e.message}`);
          }
        }
        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        if (args.clear_first) {
          await client.clearInputText();
        }

        const inputMethod = await session.setInputText(args.text);
        return {
          text: args.text,
          text_typed: args.text,
          success: true,
          input_method: inputMethod,
          postcondition: { satisfied: true },
        };
      },
    },
    {
      name: "ui.swipe",
      domain: "ui",
      description: "Perform swipe gesture from start coordinates to end coordinates",
      inputSchema: z.object({
        from_pos: z.string().optional().describe("Start position 'X,Y'"),
        to_pos: z.string().optional().describe("End position 'X,Y'"),
        from_x: z.number().optional(),
        from_y: z.number().optional(),
        to_x: z.number().optional(),
        to_y: z.number().optional(),
        duration: z.number().optional().default(0.2),
        duration_steps: z.number().optional().default(20),
        use_daemon: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        swiped: z.boolean(),
        from: z.array(z.number()).optional(),
        to: z.array(z.number()).optional(),
        duration: z.number().optional(),
        screen_fingerprint: z.string().optional(),
      }),
      safety: "interactive",
      expect: {
        schema: z.object({ swiped: z.literal(true) }),
      },
      handler: async (ctx, args) => {
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.action("swipe", args);
            ctx.serial = daemonClient.serial || ctx.serial;
            if (daemonRes.ok) return daemonRes.result;
          } catch (e: any) {
            ctx.warn(`Daemon swipe action failed, falling back to direct RPC: ${e.message}`);
          }
        }

        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        let fx = 0, fy = 0, tx = 0, ty = 0;

        if (args.from_pos && args.to_pos) {
          const fParts = args.from_pos.replace(/\s+/g, "").split(",").map(Number);
          const tParts = args.to_pos.replace(/\s+/g, "").split(",").map(Number);
          fx = fParts[0]; fy = fParts[1];
          tx = tParts[0]; ty = tParts[1];
        } else if (
          args.from_x !== undefined &&
          args.from_y !== undefined &&
          args.to_x !== undefined &&
          args.to_y !== undefined
        ) {
          fx = args.from_x; fy = args.from_y;
          tx = args.to_x; ty = args.to_y;
        } else {
          throw new UsageError("Must specify either '--from-pos X,Y --to-pos X,Y' or '--from-x ... --from-y ... --to-x ... --to-y ...'");
        }

        const steps = args.duration_steps ?? Math.round((args.duration ?? 0.2) * 100);
        await client.swipe(fx, fy, tx, ty, steps);

        return {
          swiped: true,
          from: [fx, fy],
          to: [tx, ty],
          duration: args.duration ?? 0.2,
        };
      },
    },
    {
      name: "ui.scroll",
      domain: "ui",
      description: "Perform high-level scroll gesture in specified direction",
      inputSchema: z.object({
        direction: z.enum(["down", "up", "left", "right"]).optional().default("down"),
        duration: z.number().optional().default(0.3),
        use_daemon: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        swiped: z.boolean(),
        direction: z.string(),
        screen_fingerprint: z.string().optional(),
      }),
      safety: "interactive",
      expect: {
        schema: z.object({ swiped: z.literal(true) }),
      },
      handler: async (ctx, args) => {
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.action("scroll", args);
            ctx.serial = daemonClient.serial || ctx.serial;
            if (daemonRes.ok) return daemonRes.result;
          } catch (e: any) {
            ctx.warn(`Daemon scroll action failed, falling back to direct RPC: ${e.message}`);
          }
        }

        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        const info = await client.deviceInfo();
        const width = info.displayWidth || 1080;
        const height = info.displayHeight || 2340;

        const dir = args.direction ?? "down";
        const duration = args.duration ?? 0.3;
        let fx = 0, fy = 0, tx = 0, ty = 0;

        if (dir === "down") {
          fx = Math.round(width / 2); fy = Math.round(height * 0.75);
          tx = Math.round(width / 2); ty = Math.round(height * 0.25);
        } else if (dir === "up") {
          fx = Math.round(width / 2); fy = Math.round(height * 0.25);
          tx = Math.round(width / 2); ty = Math.round(height * 0.75);
        } else if (dir === "left") {
          fx = Math.round(width * 0.85); fy = Math.round(height / 2);
          tx = Math.round(width * 0.15); ty = Math.round(height / 2);
        } else if (dir === "right") {
          fx = Math.round(width * 0.15); fy = Math.round(height / 2);
          tx = Math.round(width * 0.85); ty = Math.round(height / 2);
        }

        const steps = Math.round(duration * 100);
        await client.swipe(fx, fy, tx, ty, steps);

        return {
          swiped: true,
          direction: dir,
        };
      },
    },
    {
      name: "ui.type",
      domain: "ui",
      description: "Macro to focus input field (via selector) and type text in one step",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element handle from ui.snapshot (e.g. @1, @2)"),
        text: z.string().describe("Text to type"),
        text_contains: z.string().optional(),
        resource_id: z.string().optional(),
        description: z.string().optional(),
        desc_contains: z.string().optional(),
        bounds: z.string().optional(),
        use_daemon: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        text_typed: z.string(),
        screen_fingerprint: z.string(),
        postcondition: z.record(z.unknown()),
      }),
      safety: "interactive",
      expect: {
        schema: z.object({ text_typed: z.string() }),
      },
      handler: async (ctx, args) => {
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.action("type", args);
            ctx.serial = daemonClient.serial || ctx.serial;
            if (daemonRes.ok) return daemonRes.result;
          } catch (e: any) {
            ctx.warn(`Daemon type action failed, falling back to direct RPC: ${e.message}`);
          }
        }

        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        const hasSelector = Boolean(args.ref || args.text_contains || args.resource_id || args.description || args.desc_contains || args.bounds);
        if (hasSelector) {
          const xml = await client.dumpHierarchy(true);
          const rawElements = parseXmlDump(xml, true, false);
          const elements = deduplicateAndFilterElements(rawElements);
          const query = parseSelectorArgs(args as Record<string, unknown>);
          const matched = resolveSelector(elements, query, false, rawElements);

          if (matched.warnings.length > 0) {
            for (const w of matched.warnings) ctx.warn(w);
          }

          await client.click(matched.centerX, matched.centerY);
        }

        await session.setInputText(args.text);

        const postXml = await client.dumpHierarchy(true);
        const postElements = parseXmlDump(postXml);
        const fingerprint = computeScreenFingerprint(postElements);

        return {
          text_typed: args.text,
          screen_fingerprint: fingerprint,
          postcondition: { satisfied: true },
        };
      },
    },
    {
      name: "ui.press",
      domain: "ui",
      description: "Press hardware key or navigation key (back, home, enter, etc.)",
      inputSchema: z.object({
        key: z.string().describe("Key name (e.g. back, home, enter, delete, volume_up)"),
        use_daemon: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        key: z.string(),
        pressed: z.boolean(),
        screen_fingerprint: z.string().optional(),
      }),
      safety: "interactive",
      expect: {
        schema: z.object({ pressed: z.literal(true) }),
      },
      handler: async (ctx, args) => {
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.action("press", args);
            ctx.serial = daemonClient.serial || ctx.serial;
            if (daemonRes.ok) return daemonRes.result;
          } catch (e: any) {
            ctx.warn(`Daemon press action failed, falling back to direct RPC: ${e.message}`);
          }
        }

        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        await client.pressKey(args.key.toLowerCase());

        const postXml = await client.dumpHierarchy(true);
        const postElements = parseXmlDump(postXml);
        const fingerprint = computeScreenFingerprint(postElements);

        return {
          key: args.key,
          pressed: true,
          screen_fingerprint: fingerprint,
        };
      },
    },
    {
      name: "ui.wait",
      domain: "ui",
      description: "Wait for an element matching selector to become present or absent",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element handle from ui.snapshot (e.g. @1, @2)"),
        text: z.string().optional(),
        text_contains: z.string().optional(),
        resource_id: z.string().optional(),
        description: z.string().optional(),
        desc_contains: z.string().optional(),
        bounds: z.string().optional(),
        timeout: z.number().optional().default(10),
        timeout_seconds: z.number().optional().default(10),
        absent: z.boolean().optional().default(false),
        use_daemon: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        waited_seconds: z.number(),
        satisfied: z.boolean(),
        found: z.boolean().optional(),
        element: z.record(z.unknown()).nullable().optional(),
      }),
      safety: "read",
      handler: async (ctx, args) => {
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.action("wait", args);
            ctx.serial = daemonClient.serial || ctx.serial;
            if (daemonRes.ok) return daemonRes.result;
          } catch (e: any) {
            ctx.warn(`Daemon wait action failed, falling back to direct RPC: ${e.message}`);
          }
        }

        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        const query = parseSelectorArgs(args as Record<string, unknown>);
        const timeoutSec = Math.min(args.timeout ?? args.timeout_seconds ?? ctx.timeout ?? 10, 120);
        const absent = Boolean(args.absent);

        const startTime = Date.now();
        const deadline = startTime + timeoutSec * 1000;

        let pollInterval = 100;
        while (Date.now() < deadline) {
          try {
            const xml = await client.dumpHierarchy(true);
            const rawElements = parseXmlDump(xml, true, false);
            const elements = deduplicateAndFilterElements(rawElements);
            const matched = resolveSelector(elements, query, false, rawElements);

            if (!absent) {
              const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
              return {
                waited_seconds: duration,
                satisfied: true,
                found: true,
                element: matched.element as unknown as Record<string, unknown>,
              };
            }
          } catch (e: any) {
            if (absent && e instanceof SelectorNotFoundError) {
              const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
              return {
                waited_seconds: duration,
                satisfied: true,
                found: false,
                element: null,
              };
            }
          }
          await new Promise((r) => setTimeout(r, pollInterval));
          pollInterval = Math.min(Math.round(pollInterval * 1.5), 800);
        }

        throw new TimeoutError(`Wait timed out after ${timeoutSec}s for selector matching ${JSON.stringify(query)}`);
      },
    },
    {
      name: "ui.find",
      domain: "ui",
      description: "Scroll repeatedly until selector element is found or max scrolls reached",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element handle from ui.snapshot (e.g. @1, @2)"),
        text: z.string().optional(),
        text_contains: z.string().optional(),
        resource_id: z.string().optional(),
        description: z.string().optional(),
        desc_contains: z.string().optional(),
        bounds: z.string().optional(),
        scroll_direction: z.enum(["down", "up", "left", "right"]).optional().default("down"),
        max_scrolls: z.number().int().max(30).optional().default(10),
        scroll_duration: z.number().optional().default(0.3),
        use_daemon: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        found: z.boolean(),
        element: z.record(z.unknown()).nullable().optional(),
        scrolls_performed: z.number(),
        screen_fingerprint: z.string(),
      }),
      safety: "read",
      handler: async (ctx, args) => {
        if (args.use_daemon) {
          try {
            const daemonClient = new DaemonClient(ctx.serial);
            const daemonRes = await daemonClient.action("find", args);
            ctx.serial = daemonClient.serial || ctx.serial;
            if (daemonRes.ok) return daemonRes.result;
          } catch (e: any) {
            ctx.warn(`Daemon find action failed, falling back to direct RPC: ${e.message}`);
          }
        }

        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        const info = await client.deviceInfo();
        const width = info.displayWidth || 1080;
        const height = info.displayHeight || 2340;

        const query = parseSelectorArgs(args as Record<string, unknown>);
        const scrollDirection = args.scroll_direction ?? "down";
        const maxScrolls = Math.min(args.max_scrolls ?? 10, 30);
        const scrollDuration = args.scroll_duration ?? 0.3;

        let scrollsPerformed = 0;

        while (true) {
          const xml = await client.dumpHierarchy(true);
          const rawElements = parseXmlDump(xml, false, false);
          const elements = deduplicateAndFilterElements(rawElements);
          const fingerprint = computeScreenFingerprint(elements);

          try {
            const matched = resolveSelector(elements, query, false, rawElements);
            return {
              found: true,
              element: matched.element as unknown as Record<string, unknown>,
              scrolls_performed: scrollsPerformed,
              screen_fingerprint: fingerprint,
            };
          } catch (e: any) {
            if (!(e instanceof SelectorNotFoundError)) throw e;

            if (scrollsPerformed >= maxScrolls) {
              return {
                found: false,
                element: null,
                scrolls_performed: scrollsPerformed,
                screen_fingerprint: fingerprint,
              };
            }

            let fx = 0, fy = 0, tx = 0, ty = 0;
            if (scrollDirection === "down") {
              fx = Math.round(width / 2); fy = Math.round(height * 0.75);
              tx = Math.round(width / 2); ty = Math.round(height * 0.25);
            } else if (scrollDirection === "up") {
              fx = Math.round(width / 2); fy = Math.round(height * 0.25);
              tx = Math.round(width / 2); ty = Math.round(height * 0.75);
            } else if (scrollDirection === "left") {
              fx = Math.round(width * 0.85); fy = Math.round(height / 2);
              tx = Math.round(width * 0.15); ty = Math.round(height / 2);
            } else if (scrollDirection === "right") {
              fx = Math.round(width * 0.15); fy = Math.round(height / 2);
              tx = Math.round(width * 0.85); ty = Math.round(height / 2);
            }

            const steps = Math.round(scrollDuration * 100);
            await client.swipe(fx, fy, tx, ty, steps);
            scrollsPerformed++;
          }
        }
      },
    },
  ],
};
