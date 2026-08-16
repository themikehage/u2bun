import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { UsageError } from "../errors";

export interface CallRecord {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    exit_code?: number;
  };
  duration_sec: number;
  started_at: string;
}

export interface SessionSummary {
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  total_duration_sec: number;
}

export interface SessionRecord {
  id: string;
  name: string;
  status: "in_progress" | "completed" | "aborted";
  serial?: string;
  started_at: string;
  ended_at?: string | null;
  duration_sec: number;
  calls: CallRecord[];
  summary: SessionSummary;
}

export function formatTimestampForFile(isoString: string): string {
  const d = new Date(isoString);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}${MM}${dd}_${hh}${mm}${ss}`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "session"
  );
}

export class SessionStore {
  public static getActiveSessionPath(sessionDir: string = "./sessions"): string {
    return path.join(sessionDir, ".active_session.json");
  }

  public static startSession(
    name: string,
    serial?: string,
    sessionDir: string = "./sessions"
  ): { session_id: string; name: string; started_at: string } {
    if (!name || typeof name !== "string" || name.trim() === "") {
      throw new UsageError("Session name must be a non-empty string");
    }

    fs.mkdirSync(sessionDir, { recursive: true });

    const activeFile = this.getActiveSessionPath(sessionDir);
    if (fs.existsSync(activeFile)) {
      try {
        const raw = fs.readFileSync(activeFile, "utf-8");
        const existing = JSON.parse(raw) as SessionRecord;
        if (existing && existing.status === "in_progress") {
          existing.status = "aborted";
          existing.ended_at = new Date().toISOString();
          existing.duration_sec = Number(
            ((new Date(existing.ended_at).getTime() - new Date(existing.started_at).getTime()) / 1000).toFixed(3)
          );
          const timeStr = formatTimestampForFile(existing.started_at);
          const slug = slugify(existing.name);
          const archivedPath = path.join(sessionDir, `${timeStr}_${slug}_aborted.json`);
          fs.writeFileSync(archivedPath, JSON.stringify(existing, null, 2), "utf-8");
        }
      } catch {
        // Ignore parsing issues and overwrite
      }
    }

    const sessionId = `sess_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const startedAt = new Date().toISOString();

    const record: SessionRecord = {
      id: sessionId,
      name: name.trim(),
      status: "in_progress",
      serial,
      started_at: startedAt,
      ended_at: null,
      duration_sec: 0,
      calls: [],
      summary: {
        total_calls: 0,
        successful_calls: 0,
        failed_calls: 0,
        total_duration_sec: 0,
      },
    };

    fs.writeFileSync(activeFile, JSON.stringify(record, null, 2), "utf-8");

    return {
      session_id: sessionId,
      name: record.name,
      started_at: startedAt,
    };
  }

  public static recordCall(
    call: Omit<CallRecord, "index">,
    sessionDir: string = "./sessions"
  ): void {
    const activeFile = this.getActiveSessionPath(sessionDir);
    if (!fs.existsSync(activeFile)) {
      return;
    }

    try {
      const raw = fs.readFileSync(activeFile, "utf-8");
      const record = JSON.parse(raw) as SessionRecord;

      const fullCall: CallRecord = {
        index: record.calls.length,
        ...call,
      };

      record.calls.push(fullCall);
      record.summary.total_calls = record.calls.length;

      if (call.error) {
        record.summary.failed_calls += 1;
      } else {
        record.summary.successful_calls += 1;
      }

      record.summary.total_duration_sec = Number(
        (record.summary.total_duration_sec + (call.duration_sec || 0)).toFixed(3)
      );

      fs.writeFileSync(activeFile, JSON.stringify(record, null, 2), "utf-8");
    } catch {
      // Non-blocking recording
    }
  }

  public static endSession(sessionDir: string = "./sessions"): {
    session_id: string;
    name: string;
    file: string;
    duration_sec: number;
    summary: SessionSummary;
  } {
    const activeFile = this.getActiveSessionPath(sessionDir);
    if (!fs.existsSync(activeFile)) {
      throw new UsageError("No active session found. Start one with 'session start --name <task>'");
    }

    let record: SessionRecord;
    try {
      const raw = fs.readFileSync(activeFile, "utf-8");
      record = JSON.parse(raw) as SessionRecord;
    } catch (err: any) {
      throw new UsageError(`Failed to parse active session file: ${err.message || String(err)}`);
    }

    const endedAt = new Date().toISOString();
    record.status = "completed";
    record.ended_at = endedAt;
    record.duration_sec = Number(
      ((new Date(endedAt).getTime() - new Date(record.started_at).getTime()) / 1000).toFixed(3)
    );

    const timeStr = formatTimestampForFile(record.started_at);
    const slug = slugify(record.name);
    let filename = `${timeStr}_${slug}.json`;
    let targetPath = path.join(sessionDir, filename);

    if (fs.existsSync(targetPath)) {
      filename = `${timeStr}_${slug}_${record.id.slice(-6)}.json`;
      targetPath = path.join(sessionDir, filename);
    }

    fs.writeFileSync(targetPath, JSON.stringify(record, null, 2), "utf-8");
    fs.unlinkSync(activeFile);

    return {
      session_id: record.id,
      name: record.name,
      file: targetPath,
      duration_sec: record.duration_sec,
      summary: record.summary,
    };
  }

  public static getActiveSession(sessionDir: string = "./sessions"): SessionRecord | null {
    const activeFile = this.getActiveSessionPath(sessionDir);
    if (!fs.existsSync(activeFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(activeFile, "utf-8")) as SessionRecord;
    } catch {
      return null;
    }
  }
}
