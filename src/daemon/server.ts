import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { DeviceSession } from "../runtime/device";
import type { ActionElement } from "../models";
import { parseXmlDump, computeScreenFingerprint, formatCompactSnapshot, checkExpect, sortByRelevance, deduplicateAndFilterElements } from "../domains/ui";
import { parseSelectorArgs } from "../selectors/parser";
import { resolveSelector } from "../selectors/resolver";
import { SelectorNotFoundError, UsageError } from "../errors";

export const BUILD_ID = "0.1.0-v4";

export function getDaemonConfigPath(serial?: string): string {
  const safeSerial = String(serial || "default").replace(/[^a-zA-Z0-9_\-]/g, "_");
  return join(tmpdir(), `u2bun-daemon-${safeSerial}.json`);
}

export interface DaemonInfo {
  port: number;
  pid: number;
  serial: string;
  build_id: string;
}

export class DaemonServer {
  public serial: string;
  public port: number;
  private session: DeviceSession | null = null;
  private elements: ActionElement[] = [];
  private handles: Map<string, ActionElement> = new Map();
  private fingerprint: string = "";
  private prevSnapshotLines: string[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private deviceInfoCache: { width: number; height: number } | null = null;

  constructor(serial: string, port: number = 0) {
    this.serial = serial;
    this.port = port;
  }

  private async getScreenDimensions(client: any): Promise<{ width: number; height: number }> {
    if (!this.deviceInfoCache) {
      try {
        const info = await client.deviceInfo();
        this.deviceInfoCache = {
          width: info.displayWidth || 1080,
          height: info.displayHeight || 2340,
        };
      } catch {
        return { width: 1080, height: 2340 };
      }
    }
    return this.deviceInfoCache;
  }

  private async getSession(): Promise<DeviceSession> {
    if (!this.session) {
      this.session = new DeviceSession(this.serial);
    }
    await this.session.connect();
    return this.session;
  }

  public async start(): Promise<DaemonInfo> {
    const self = this;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/ping") {
          return Response.json({ ok: true, serial: self.serial, pid: process.pid, build_id: BUILD_ID });
        }

        if (url.pathname === "/health") {
          try {
            const session = await self.getSession();
            let u2Up = false;
            if (session.client) {
              try {
                await session.client.ping();
                u2Up = true;
              } catch {}
            }
            return Response.json({
              ok: true,
              device: "online",
              adb: true,
              u2_runtime: u2Up ? "up" : "down",
              port_forward: true,
              serial: self.serial,
              build_id: BUILD_ID,
            });
          } catch (err: any) {
            return Response.json({
              ok: false,
              device: "offline",
              adb: false,
              u2_runtime: "down",
              error: err.message || String(err),
            }, { status: 503 });
          }
        }

        if (url.pathname === "/snapshot" && req.method === "POST") {
          try {
            const body = await req.json().catch(() => ({}));
            const includeSystemBars = Boolean(body.include_system_bars);
            const session = await self.getSession();
            const client = session.client!;

            let packageName: string | undefined = undefined;
            try {
              const info = await client.deviceInfo();
              packageName = info.currentPackageName;
            } catch {}

            const xml = await client.dumpHierarchy(true);
            const rawElements = parseXmlDump(xml, includeSystemBars, false);
            const rawCount = rawElements.length;
            let dedupedElements = deduplicateAndFilterElements(rawElements);
            const totalCount = dedupedElements.length;

            if (body.limit && body.limit > 0 && dedupedElements.length > body.limit) {
              const { width, height } = await self.getScreenDimensions(client);
              dedupedElements = sortByRelevance(dedupedElements, width, height).slice(0, body.limit);
            }

            self.handles.clear();
            self.elements = dedupedElements.map((el, i) => {
              const ref = `@${i + 1}`;
              const item = { ...el, ref, index: i };
              self.handles.set(ref, item);
              return item;
            });

            const newFingerprint = computeScreenFingerprint(self.elements);
            const hasPrev = self.fingerprint !== "";
            const changed = hasPrev ? self.fingerprint !== newFingerprint : undefined;
            self.fingerprint = newFingerprint;

            let snapshotText = formatCompactSnapshot(
              self.elements,
              packageName,
              body.fingerprint ? self.fingerprint : undefined,
              changed,
              totalCount
            );

            if (body.diff && hasPrev && self.prevSnapshotLines.length > 0) {
              const currentLines = snapshotText.split("\n");
              const header = currentLines[0];
              const prevSet = new Set(self.prevSnapshotLines.slice(1));
              const changedLines = currentLines.slice(1).filter((line) => !prevSet.has(line));
              snapshotText = [header, ...changedLines].join("\n");
            }
            self.prevSnapshotLines = snapshotText.split("\n");

            const handleObj: Record<string, unknown> = {};
            if (body.include_handles) {
              self.handles.forEach((v, k) => {
                handleObj[k] = { text: v.text, resourceId: v.resourceId, bounds: v.bounds };
              });
            }

            return Response.json({
              ok: true,
              screen_fingerprint: self.fingerprint,
              element_count: self.elements.length,
              raw_count: rawCount,
              snapshot: snapshotText,
              ...(body.include_handles ? { handles: handleObj } : {}),
            });
          } catch (err: any) {
            return Response.json({ ok: false, error: err.message, code: err.code || "INTERNAL" }, { status: 500 });
          }
        }

        if (url.pathname === "/action" && req.method === "POST") {
          try {
            const body = await req.json();
            const { command, args } = body;
            const session = await self.getSession();
            const client = session.client!;

            if (command === "tap") {
              let targetX: number;
              let targetY: number;

              if (args.pos) {
                const parts = String(args.pos).replace(/\s+/g, "").split(",").map(Number);
                if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
                  throw new UsageError(`Invalid --pos coordinates '${args.pos}'. Expected 'X,Y' format.`);
                }
                targetX = parts[0];
                targetY = parts[1];
              } else if (args.ref && self.handles.has(args.ref)) {
                const el = self.handles.get(args.ref)!;
                const matched = resolveSelector([el], { ref: args.ref });
                targetX = matched.centerX;
                targetY = matched.centerY;
              } else {
                if (self.elements.length === 0) {
                  const xml = await client.dumpHierarchy(true);
                  self.elements = parseXmlDump(xml, true);
                }
                const query = parseSelectorArgs(args);
                const matched = resolveSelector(self.elements, query);
                targetX = matched.centerX;
                targetY = matched.centerY;
              }

              const preFingerprint = self.fingerprint;
              await client.click(targetX, targetY);

              const hasExpect = Boolean(args.expect_desc_contains || args.expect_text_contains || args.expect_element_absent);
              const postcondition: Record<string, unknown> = {};

              if (hasExpect) {
                const postXml = await client.dumpHierarchy(true);
                const postElements = parseXmlDump(postXml, true);
                const postFingerprint = computeScreenFingerprint(postElements);
                self.fingerprint = postFingerprint;
                postcondition.screen_changed = preFingerprint !== postFingerprint;
                postcondition.screen_fingerprint = postFingerprint;

                const [satisfied, matchedElem] = checkExpect(args, postElements);
                postcondition.expect_satisfied = satisfied;
                if (matchedElem) postcondition.matched_element = matchedElem;
              }

              return Response.json({
                ok: true,
                result: {
                  tapped: true,
                  x: targetX,
                  y: targetY,
                  ...(hasExpect ? { postcondition } : {}),
                },
              });
            }

            if (command === "long_press") {
              let matched: ReturnType<typeof resolveSelector>;
              if (args.ref && self.handles.has(args.ref)) {
                const el = self.handles.get(args.ref)!;
                matched = resolveSelector([el], { ref: args.ref });
              } else {
                if (self.elements.length === 0) {
                  const xml = await client.dumpHierarchy(true);
                  self.elements = parseXmlDump(xml, true);
                }
                const query = parseSelectorArgs(args);
                matched = resolveSelector(self.elements, query);
              }

              const preFingerprint = self.fingerprint;
              const duration = args.duration ?? 1.0;
              await client.longClick(matched.centerX, matched.centerY, duration);

              const postXml = await client.dumpHierarchy(true);
              const postElements = parseXmlDump(postXml, true);
              const postFingerprint = computeScreenFingerprint(postElements);
              self.fingerprint = postFingerprint;

              const postcondition: Record<string, unknown> = {
                screen_changed: preFingerprint !== postFingerprint,
                screen_fingerprint: postFingerprint,
              };

              const hasExpect = Boolean(args.expect_desc_contains || args.expect_text_contains || args.expect_element_absent);
              if (hasExpect) {
                const [satisfied, matchedElem] = checkExpect(args, postElements);
                postcondition.expect_satisfied = satisfied;
                if (matchedElem) postcondition.matched_element = matchedElem;
              }

              return Response.json({
                ok: true,
                result: {
                  duration,
                  postcondition,
                  element: matched.element,
                  bounds: matched.element.bounds,
                },
              });
            }

            if (command === "input") {
              if (args.clear_first) {
                await client.clearInputText();
              }
              const inputMethod = await session.setInputText(args.text);
              return Response.json({
                ok: true,
                result: {
                  text: args.text,
                  text_typed: args.text,
                  success: true,
                  input_method: inputMethod,
                  postcondition: { satisfied: true },
                },
              });
            }

            if (command === "swipe") {
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

              return Response.json({
                ok: true,
                result: {
                  swiped: true,
                  from: [fx, fy],
                  to: [tx, ty],
                  duration: args.duration ?? 0.2,
                },
              });
            }

            if (command === "scroll") {
              const { width, height } = await self.getScreenDimensions(client);

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

              return Response.json({
                ok: true,
                result: {
                  swiped: true,
                  direction: dir,
                },
              });
            }

            if (command === "type") {
              const hasSelector = Boolean(args.ref || args.text_contains || args.resource_id || args.description || args.desc_contains || args.bounds);
              if (hasSelector) {
                let matched: ReturnType<typeof resolveSelector>;
                if (args.ref && self.handles.has(args.ref)) {
                  const el = self.handles.get(args.ref)!;
                  matched = resolveSelector([el], { ref: args.ref });
                } else {
                  if (self.elements.length === 0) {
                    const xml = await client.dumpHierarchy(true);
                    self.elements = parseXmlDump(xml, true);
                  }
                  const query = parseSelectorArgs(args);
                  matched = resolveSelector(self.elements, query);
                }
                await client.click(matched.centerX, matched.centerY);
              }

              await session.setInputText(args.text);

              const postXml = await client.dumpHierarchy(true);
              const postElements = parseXmlDump(postXml);
              const fingerprint = computeScreenFingerprint(postElements);
              self.fingerprint = fingerprint;

              return Response.json({
                ok: true,
                result: {
                  text_typed: args.text,
                  screen_fingerprint: fingerprint,
                  postcondition: { satisfied: true },
                },
              });
            }

            if (command === "press") {
              await client.pressKey(String(args.key).toLowerCase());
              const postXml = await client.dumpHierarchy(true);
              const postElements = parseXmlDump(postXml);
              const fingerprint = computeScreenFingerprint(postElements);
              self.fingerprint = fingerprint;

              return Response.json({
                ok: true,
                result: {
                  key: args.key,
                  pressed: true,
                  screen_fingerprint: fingerprint,
                },
              });
            }

            if (command === "wait") {
              const query = parseSelectorArgs(args);
              const timeoutSec = Math.min(args.timeout ?? args.timeout_seconds ?? 10, 120);
              const absent = Boolean(args.absent);
              const startTime = Date.now();
              const deadline = startTime + timeoutSec * 1000;

              let pollInterval = 100;
              while (Date.now() < deadline) {
                try {
                  const xml = await client.dumpHierarchy(true);
                  const elements = parseXmlDump(xml, true);
                  const matched = resolveSelector(elements, query);

                  if (!absent) {
                    const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
                    return Response.json({
                      ok: true,
                      result: {
                        waited_seconds: duration,
                        satisfied: true,
                        found: true,
                        element: matched.element,
                      },
                    });
                  }
                } catch (e: any) {
                  if (absent && e instanceof SelectorNotFoundError) {
                    const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
                    return Response.json({
                      ok: true,
                      result: {
                        waited_seconds: duration,
                        satisfied: true,
                        found: false,
                        element: null,
                      },
                    });
                  }
                  if (!(e instanceof SelectorNotFoundError)) throw e;
                }
                await new Promise((r) => setTimeout(r, pollInterval));
                pollInterval = Math.min(Math.round(pollInterval * 1.5), 800);
              }

              const duration = Number(((Date.now() - startTime) / 1000).toFixed(2));
              return Response.json({
                ok: true,
                result: {
                  waited_seconds: duration,
                  satisfied: false,
                  found: !absent,
                  element: null,
                },
              });
            }

            if (command === "find") {
              const { width, height } = await self.getScreenDimensions(client);

              const query = parseSelectorArgs(args);
              const scrollDirection = args.scroll_direction ?? "down";
              const maxScrolls = Math.min(args.max_scrolls ?? 10, 30);
              const scrollDuration = args.scroll_duration ?? 0.3;

              let scrollsPerformed = 0;

              while (true) {
                const xml = await client.dumpHierarchy(true);
                const elements = parseXmlDump(xml);
                const fingerprint = computeScreenFingerprint(elements);

                try {
                  const matched = resolveSelector(elements, query);
                  return Response.json({
                    ok: true,
                    result: {
                      found: true,
                      element: matched.element,
                      scrolls_performed: scrollsPerformed,
                      screen_fingerprint: fingerprint,
                    },
                  });
                } catch (e: any) {
                  if (!(e instanceof SelectorNotFoundError)) throw e;

                  if (scrollsPerformed >= maxScrolls) {
                    return Response.json({
                      ok: true,
                      result: {
                        found: false,
                        element: null,
                        scrolls_performed: scrollsPerformed,
                        screen_fingerprint: fingerprint,
                      },
                    });
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
            }

            return Response.json({ ok: false, error: `Unknown daemon command: ${command}` }, { status: 400 });
          } catch (err: any) {
            return Response.json({ ok: false, error: err.message }, { status: 500 });
          }
        }

        if (url.pathname === "/shutdown" && req.method === "POST") {
          self.stop();
          return Response.json({ ok: true, message: "Daemon shutting down" });
        }

        return Response.json({ ok: false, error: "Not found" }, { status: 404 });
      },
    });

    const info: DaemonInfo = {
      port: this.server.port,
      pid: process.pid,
      serial: this.serial,
      build_id: BUILD_ID,
    };

    const configPath = getDaemonConfigPath(this.serial);
    if (existsSync(configPath)) {
      try {
        const prev = JSON.parse(readFileSync(configPath, "utf-8"));
        if (prev.pid) {
          try {
            process.kill(prev.pid, 0);
          } catch {
            try { unlinkSync(configPath); } catch {}
          }
        }
      } catch {
        try { unlinkSync(configPath); } catch {}
      }
    }
    writeFileSync(configPath, JSON.stringify(info, null, 2), "utf-8");

    return info;
  }

  public stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    const configPath = getDaemonConfigPath(this.serial);
    if (existsSync(configPath)) {
      try {
        unlinkSync(configPath);
      } catch {}
    }
  }
}

if (import.meta.main) {
  const serialIdx = process.argv.indexOf("--serial");
  const serial = serialIdx !== -1 ? process.argv[serialIdx + 1] : "";
  const stopFlag = process.argv.includes("--stop");

  if (!serial) {
    console.error("Usage: bun run server.ts --serial <SERIAL> [--stop]");
    process.exit(1);
  }

  if (stopFlag) {
    const configPath = getDaemonConfigPath(serial);
    if (existsSync(configPath)) {
      try {
        const info = JSON.parse(readFileSync(configPath, "utf-8"));
        fetch(`http://127.0.0.1:${info.port}/shutdown`, { method: "POST" }).catch(() => {});
        unlinkSync(configPath);
        console.log(`u2bun daemon stopped for device ${serial}`);
      } catch {
        console.log(`u2bun daemon config cleaned for device ${serial}`);
      }
    } else {
      console.log(`No active u2bun daemon found for device ${serial}`);
    }
    process.exit(0);
  }

  const server = new DaemonServer(serial);
  server.start().then((info) => {
    console.log(`u2bun daemon started for device ${info.serial} on port ${info.port} (PID ${info.pid})`);
  });
}
