import { z } from "zod";
import type { DomainSpec } from "../registry";
import { SessionStore } from "../session/store";

export const SESSION_DOMAIN: DomainSpec = {
  name: "session",
  description: "Session recording domain for statistical JSON tracking",
  tools: [
    {
      name: "session.start",
      domain: "session",
      description: "Start a new recording session to track CLI inputs, outputs, and durations.",
      inputSchema: z.object({
        name: z.string().describe("Name or description of the task being executed"),
        output_dir: z.string().optional().describe("Custom output directory for session logs (defaults to ./sessions)"),
      }),
      outputSchema: z.object({
        session_id: z.string(),
        name: z.string(),
        started_at: z.string(),
      }),
      safety: "read",
      idempotent: false,
      handler: async (ctx, args) => {
        const sessionDir = args.output_dir || ctx.sessionDir || "./sessions";
        return SessionStore.startSession(args.name, ctx.serial, sessionDir);
      },
    },
    {
      name: "session.end",
      domain: "session",
      description: "End the active recording session, summarize metrics, and save final JSON log.",
      inputSchema: z.object({
        output_dir: z.string().optional().describe("Custom output directory for session logs (defaults to ./sessions)"),
      }),
      outputSchema: z.object({
        session_id: z.string(),
        name: z.string(),
        file: z.string(),
        duration_sec: z.number(),
        summary: z.object({
          total_calls: z.number(),
          successful_calls: z.number(),
          failed_calls: z.number(),
          total_duration_sec: z.number(),
        }),
      }),
      safety: "read",
      idempotent: false,
      handler: async (ctx, args) => {
        const sessionDir = args.output_dir || ctx.sessionDir || "./sessions";
        return SessionStore.endSession(sessionDir);
      },
    },
    {
      name: "session.status",
      domain: "session",
      description: "Get the current active session status and progress.",
      inputSchema: z.object({
        output_dir: z.string().optional().describe("Custom output directory for session logs (defaults to ./sessions)"),
      }),
      outputSchema: z.object({
        active: z.boolean(),
        session_id: z.string().optional(),
        name: z.string().optional(),
        started_at: z.string().optional(),
        total_calls: z.number().optional(),
      }),
      safety: "read",
      idempotent: true,
      handler: async (ctx, args) => {
        const sessionDir = args.output_dir || ctx.sessionDir || "./sessions";
        const session = SessionStore.getActiveSession(sessionDir);
        if (!session) {
          return { active: false };
        }
        return {
          active: true,
          session_id: session.id,
          name: session.name,
          started_at: session.started_at,
          total_calls: session.summary.total_calls,
        };
      },
    },
  ],
};
