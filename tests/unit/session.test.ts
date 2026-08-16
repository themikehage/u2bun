import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionStore } from "../../src/session/store";
import { SESSION_DOMAIN } from "../../src/domains/session";
import { registry, type HandlerContext } from "../../src/registry";
import { runCli } from "../../src/cli";

const TEST_SESSION_DIR = path.join(process.cwd(), "tests", "scratch_sessions");

describe("Session Recording & Statistical Logs", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_SESSION_DIR)) {
      fs.rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_SESSION_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_SESSION_DIR)) {
      fs.rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
    }
  });

  it("startSession creates .active_session.json with valid structure", () => {
    const started = SessionStore.startSession("Test Login Task", "device123", TEST_SESSION_DIR);
    expect(started.session_id).toMatch(/^sess_\d+_[a-f0-9]+/);
    expect(started.name).toBe("Test Login Task");
    expect(started.started_at).toBeDefined();

    const active = SessionStore.getActiveSession(TEST_SESSION_DIR);
    expect(active).not.toBeNull();
    expect(active?.id).toBe(started.session_id);
    expect(active?.status).toBe("in_progress");
    expect(active?.serial).toBe("device123");
    expect(active?.calls).toEqual([]);
    expect(active?.summary.total_calls).toBe(0);
  });

  it("recordCall appends successful and failed calls and updates summary", () => {
    SessionStore.startSession("Audit Flow", undefined, TEST_SESSION_DIR);

    SessionStore.recordCall(
      {
        tool: "ui.snapshot",
        args: { limit: 10 },
        result: { snapshot: "Tree...", element_count: 5 },
        duration_sec: 0.045,
        started_at: new Date().toISOString(),
      },
      TEST_SESSION_DIR
    );

    SessionStore.recordCall(
      {
        tool: "ui.tap",
        args: { ref: "@5" },
        error: { code: "SELECTOR_NOT_FOUND", message: "Element @5 missing", exit_code: 3 },
        duration_sec: 0.02,
        started_at: new Date().toISOString(),
      },
      TEST_SESSION_DIR
    );

    const active = SessionStore.getActiveSession(TEST_SESSION_DIR);
    expect(active?.calls.length).toBe(2);
    expect(active?.calls[0].index).toBe(0);
    expect(active?.calls[0].tool).toBe("ui.snapshot");
    expect(active?.calls[0].result).toEqual({ snapshot: "Tree...", element_count: 5 });
    expect(active?.calls[1].index).toBe(1);
    expect(active?.calls[1].tool).toBe("ui.tap");
    expect(active?.calls[1].error?.code).toBe("SELECTOR_NOT_FOUND");

    expect(active?.summary.total_calls).toBe(2);
    expect(active?.summary.successful_calls).toBe(1);
    expect(active?.summary.failed_calls).toBe(1);
    expect(active?.summary.total_duration_sec).toBe(0.065);
  });

  it("endSession writes completed JSON log and removes active session", () => {
    SessionStore.startSession("Complete Task", "dev1", TEST_SESSION_DIR);

    SessionStore.recordCall(
      {
        tool: "app.start",
        args: { package: "com.example.app" },
        result: { started: true },
        duration_sec: 0.1,
        started_at: new Date().toISOString(),
      },
      TEST_SESSION_DIR
    );

    const ended = SessionStore.endSession(TEST_SESSION_DIR);
    expect(ended.session_id).toBeDefined();
    expect(ended.file).toContain("complete-task.json");
    expect(fs.existsSync(ended.file)).toBe(true);

    const activeAfterEnd = SessionStore.getActiveSession(TEST_SESSION_DIR);
    expect(activeAfterEnd).toBeNull();

    const savedJson = JSON.parse(fs.readFileSync(ended.file, "utf-8"));
    expect(savedJson.status).toBe("completed");
    expect(savedJson.ended_at).toBeDefined();
    expect(savedJson.duration_sec).toBeGreaterThanOrEqual(0);
    expect(savedJson.calls.length).toBe(1);
    expect(savedJson.summary.total_calls).toBe(1);
    expect(savedJson.summary.successful_calls).toBe(1);
  });

  it("starting a new session when one is active archives previous as aborted", () => {
    SessionStore.startSession("First Task", undefined, TEST_SESSION_DIR);
    SessionStore.recordCall(
      {
        tool: "ui.snapshot",
        args: {},
        result: { ok: true },
        duration_sec: 0.05,
        started_at: new Date().toISOString(),
      },
      TEST_SESSION_DIR
    );

    const second = SessionStore.startSession("Second Task", undefined, TEST_SESSION_DIR);
    expect(second.name).toBe("Second Task");

    const files = fs.readdirSync(TEST_SESSION_DIR);
    const abortedFile = files.find((f) => f.includes("first-task_aborted.json"));
    expect(abortedFile).toBeDefined();

    const abortedContent = JSON.parse(fs.readFileSync(path.join(TEST_SESSION_DIR, abortedFile!), "utf-8"));
    expect(abortedContent.status).toBe("aborted");
    expect(abortedContent.calls.length).toBe(1);
  });

  it("SESSION_DOMAIN tools execute through registry handlers", async () => {
    if (!registry.hasDomain("session")) {
      registry.registerDomain(SESSION_DOMAIN);
    }

    const startTool = registry.getTool("session.start")!;
    const statusTool = registry.getTool("session.status")!;
    const endTool = registry.getTool("session.end")!;

    const ctx: HandlerContext = {
      timeout: 30,
      debug: false,
      warnings: [],
      sessionDir: TEST_SESSION_DIR,
      warn: () => {},
      callTool: async () => ({} as any),
    };

    const startRes = (await startTool.handler(ctx, {
      name: "Domain Task",
      output_dir: TEST_SESSION_DIR,
    })) as any;
    expect(startRes.session_id).toBeDefined();

    const statusRes = (await statusTool.handler(ctx, {
      output_dir: TEST_SESSION_DIR,
    })) as any;
    expect(statusRes.active).toBe(true);
    expect(statusRes.name).toBe("Domain Task");

    const endRes = (await endTool.handler(ctx, {
      output_dir: TEST_SESSION_DIR,
    })) as any;
    expect(endRes.file).toBeDefined();
    expect(fs.existsSync(endRes.file)).toBe(true);
  });

  it("CLI full workflow records inputs and outputs across executions", async () => {
    // 1. Start session
    const startCode = await runCli([
      "session",
      "start",
      "--name",
      "E2E CLI Flow",
      "--session-dir",
      TEST_SESSION_DIR,
    ]);
    expect(startCode).toBe(0);

    // 2. Run a command (e.g. tools list)
    const listCode = await runCli([
      "tools",
      "list",
      "--session-dir",
      TEST_SESSION_DIR,
    ]);
    expect(listCode).toBe(0);

    // 3. End session
    const endCode = await runCli([
      "session",
      "end",
      "--session-dir",
      TEST_SESSION_DIR,
    ]);
    expect(endCode).toBe(0);

    // Verify written JSON
    const files = fs.readdirSync(TEST_SESSION_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const log = JSON.parse(fs.readFileSync(path.join(TEST_SESSION_DIR, files[0]), "utf-8"));
    expect(log.name).toBe("E2E CLI Flow");
    expect(log.status).toBe("completed");
    expect(log.calls.length).toBe(1);
    expect(log.calls[0].tool).toBe("tools.list");
    expect(log.calls[0].result).toBeDefined();
    expect(log.calls[0].result.tools).toBeDefined();
  });
});
