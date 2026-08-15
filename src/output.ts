import type { JsonEnvelope } from "./models";
import { U2Error } from "./errors";

export function formatSuccessEnvelope<T = Record<string, unknown>>(
  command: string,
  device?: string,
  result?: T,
  warnings: string[] = []
): JsonEnvelope<T> {
  return {
    schema_version: "1",
    ok: true,
    command,
    ...(device ? { device } : {}),
    result: result ?? ({} as T),
    warnings,
  };
}

export function formatErrorEnvelope(
  command: string,
  error: Error | U2Error,
  device?: string,
  warnings: string[] = []
): JsonEnvelope {
  if (error instanceof U2Error) {
    return {
      schema_version: "1",
      ok: false,
      command,
      ...(device ? { device } : {}),
      warnings,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        hint: error.hint,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  return {
    schema_version: "1",
    ok: false,
    command,
    ...(device ? { device } : {}),
    warnings,
    error: {
      code: "INTERNAL",
      message: error.message || "An unexpected error occurred",
      retryable: false,
      hint: "Report the command + JSON envelope",
    },
  };
}

export function renderOutput(
  envelope: JsonEnvelope,
  quiet: boolean = false,
  json: boolean = false
): void {
  // Always emit warnings to stderr immediately so they are never lost
  if (envelope.warnings && envelope.warnings.length > 0) {
    for (const w of envelope.warnings) {
      console.error(`Warning: ${w}`);
    }
  }

  if (quiet && envelope.ok) {
    return;
  }

  if (json) {
    console.log(JSON.stringify(envelope));
    return;
  }

  if (!envelope.ok && envelope.error) {
    console.error(`Error [${envelope.error.code}]: ${envelope.error.message}`);
    if (envelope.error.hint) {
      console.error(`hint: ${envelope.error.hint}`);
    }
    if (envelope.error.retryable !== undefined) {
      console.error(`retryable: ${envelope.error.retryable}`);
    }
    return;
  }

  const res = envelope.result as Record<string, any> | undefined;

  if (res) {
    // 1. ui.snapshot: output snapshot text string directly
    if (typeof res.snapshot === "string") {
      console.log(res.snapshot);
      return;
    }

    // 2. Query commands: app.current, app.list, device.list, device.status/auto, daemon.status
    if (typeof res.running === "boolean") {
      if (res.running) {
        console.log(`running\tport:${res.port}\tpid:${res.pid}\tbuild:${res.build_id || ""}`);
      } else {
        console.log("stopped");
      }
      return;
    }
    if (typeof res.package === "string" && typeof res.activity === "string" && !res.started && !res.stopped) {
      console.log(`${res.package}/${res.activity}`);
      return;
    }
    if (Array.isArray(res.packages)) {
      console.log(res.packages.join("\n"));
      return;
    }
    if (Array.isArray(res.devices)) {
      const lines = res.devices.map((d: any) => `${d.serial}\t${d.state}\t${d.model || ""}`.trim());
      console.log(lines.join("\n"));
      return;
    }
    if (typeof res.serial === "string" && typeof res.state === "string") {
      console.log(`${res.serial}\t${res.state}\t${res.model || ""}`.trim());
      return;
    }

    // 3. Action commands (tap, input, press, swipe, long_press, wait, app.start, app.stop, daemon.restart, daemon.stop, etc.): return "ok"
    if (
      res.tapped ||
      res.success ||
      res.pressed ||
      res.swiped ||
      res.started ||
      res.stopped ||
      res.restarted ||
      res.satisfied ||
      res.duration !== undefined ||
      Object.keys(res).length === 0
    ) {
      console.log("ok");
      return;
    }

    // Fallback if result is a raw object
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("ok");
  }
}
