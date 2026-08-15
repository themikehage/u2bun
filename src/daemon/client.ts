import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getDaemonConfigPath, type DaemonInfo, BUILD_ID } from "./server";

export class DaemonClient {
  public serial: string;
  private port: number | null = null;

  constructor(serial?: string) {
    this.serial = serial || "";
  }

  private async ensureSerial(): Promise<string> {
    if (!this.serial) {
      const { selectTargetDevice } = await import("../runtime/adb");
      const { target } = await selectTargetDevice();
      this.serial = target.serial;
    }
    return this.serial;
  }

  private async getActivePort(): Promise<number | null> {
    await this.ensureSerial();
    if (this.port !== null) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/ping`, { signal: AbortSignal.timeout(300) });
        if (res.ok) {
          const data: any = await res.json();
          if (data.ok && data.serial === this.serial && data.build_id === BUILD_ID) {
            return this.port;
          }
        }
      } catch {
        this.port = null;
      }
    }

    const configPath = getDaemonConfigPath(this.serial);
    if (!existsSync(configPath)) return null;

    try {
      const content = readFileSync(configPath, "utf-8");
      const info: DaemonInfo = JSON.parse(content);

      // PID liveness check
      if (info.pid) {
        try {
          process.kill(info.pid, 0);
        } catch {
          // Process is not running
          try { unlinkSync(configPath); } catch {}
          return null;
        }
      }

      const res = await fetch(`http://127.0.0.1:${info.port}/ping`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        const data: any = await res.json();
        if (data.ok && data.serial === this.serial) {
          if (data.build_id === BUILD_ID) {
            this.port = info.port;
            return info.port;
          } else {
            // Version skew detected: shutdown outdated daemon
            try {
              await fetch(`http://127.0.0.1:${info.port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(500) });
            } catch {}
            try { unlinkSync(configPath); } catch {}
            return null;
          }
        }
      }
    } catch {}

    try {
      unlinkSync(configPath);
    } catch {}

    return null;
  }

  public async ensureDaemon(): Promise<number> {
    let port = await this.getActivePort();
    if (port !== null) {
      this.port = port;
      return port;
    }

    const serverScript = join(import.meta.dir, "server.ts");
    const child = spawn("bun", ["run", serverScript, "--serial", this.serial], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      port = await this.getActivePort();
      if (port !== null) {
        this.port = port;
        return port;
      }
    }

    throw new Error(`Failed to start u2bun daemon for device '${this.serial}'`);
  }

  public async stopDaemon(): Promise<boolean> {
    await this.ensureSerial();
    const configPath = getDaemonConfigPath(this.serial);
    let stopped = false;
    const port = await this.getActivePort();
    if (port !== null) {
      try {
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(1000) });
        stopped = true;
      } catch {}
    }
    if (existsSync(configPath)) {
      try {
        unlinkSync(configPath);
      } catch {}
    }
    this.port = null;
    return stopped;
  }

  public async getStatus(): Promise<{
    running: boolean;
    port?: number;
    pid?: number;
    build_id?: string;
    health?: Record<string, unknown>;
  }> {
    const port = await this.getActivePort();
    if (port === null) {
      return { running: false };
    }

    try {
      const pingRes = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(500) });
      const pingData: any = pingRes.ok ? await pingRes.json() : {};

      let health: Record<string, unknown> | undefined = undefined;
      try {
        const healthRes = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (healthRes.ok) {
          health = await healthRes.json();
        }
      } catch {}

      return {
        running: true,
        port,
        pid: pingData.pid,
        build_id: pingData.build_id,
        ...(health ? { health } : {}),
      };
    } catch {
      return { running: false };
    }
  }

  public async snapshot(args: Record<string, unknown> = {}): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const port = await this.ensureDaemon();
        const res = await fetch(`http://127.0.0.1:${port}/snapshot`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Connection: "keep-alive" },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(`Daemon snapshot failed: ${err.error || res.statusText}`);
        }
        return await res.json();
      } catch (err: any) {
        this.port = null;
        if (attempt === 1) throw err;
      }
    }
  }

  public async action(command: string, args: Record<string, unknown> = {}): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const port = await this.ensureDaemon();
        const res = await fetch(`http://127.0.0.1:${port}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Connection: "keep-alive" },
          body: JSON.stringify({ command, args }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(`Daemon action failed: ${err.error || res.statusText}`);
        }
        return await res.json();
      } catch (err: any) {
        this.port = null;
        if (attempt === 1) throw err;
      }
    }
  }
}
