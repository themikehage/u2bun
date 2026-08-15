import { z } from "zod";
import type { DomainSpec } from "../registry";
import { execAdb, selectTargetDevice } from "../runtime/adb";
import { DeviceSession } from "../runtime/device";
import { AppNotFoundError } from "../errors";

export const APP_DOMAIN: DomainSpec = {
  name: "app",
  description: "Android application lifecycle management (start, stop, current, list)",
  tools: [
    {
      name: "app.current",
      domain: "app",
      description: "Get package name and active activity of foreground application",
      inputSchema: z.object({}),
      outputSchema: z.object({
        package: z.string(),
        activity: z.string(),
      }),
      safety: "read",
      handler: async (ctx) => {
        const session = new DeviceSession(ctx.serial, ctx.timeout);
        const client = await session.connect();
        ctx.serial = session.serial;

        const info = await client.deviceInfo();
        const pkg = info.currentPackageName || "";

        // Query current activity via ADB dumpsys window
        const { stdout } = await execAdb(["-s", session.serial, "shell", "dumpsys", "window", "displays"]);
        let activity = "";
        for (const line of stdout.split("\n")) {
          if (line.includes("mCurrentFocus") || line.includes("mFocusedApp")) {
            const match = line.match(/\{[^\}\s]+\s+[^\}\s]+\s+([^\/\}\s]+)\/([^\/\}\s]+)/);
            if (match) {
              activity = match[2];
              break;
            }
          }
        }

        return { package: pkg, activity };
      },
    },
    {
      name: "app.start",
      domain: "app",
      description: "Launch specified application by package name",
      inputSchema: z.object({
        package: z.string().describe("Target application package name"),
        activity: z.string().optional().describe("Optional main activity name"),
        stop_first: z.boolean().optional().default(false),
      }),
      outputSchema: z.object({
        package: z.string(),
        started: z.boolean(),
        launcher: z.boolean().optional(),
      }),
      safety: "interactive",
      expect: {
        schema: z.object({ started: z.literal(true) }),
      },
      handler: async (ctx, args) => {
        const { target } = await selectTargetDevice(ctx.serial);
        ctx.serial = target.serial;

        if (args.stop_first) {
          await execAdb(["-s", target.serial, "shell", "am", "force-stop", args.package]);
        }

        let usedMonkey = false;
        let startSuccess = false;

        if (args.activity) {
          const { exitCode, stderr, stdout } = await execAdb([
            "-s", target.serial, "shell", "am", "start", "-n", `${args.package}/${args.activity}`
          ]);
          if (exitCode === 0 && !stderr.includes("Error: Activity class") && !stdout.includes("Error: Activity class")) {
            startSuccess = true;
          }
        } else {
          // Attempt fast resolve-activity first
          let resolvedActivity: string | null = null;
          try {
            const res = await execAdb(["-s", target.serial, "shell", "cmd", "package", "resolve-activity", "--brief", args.package]);
            if (res.exitCode === 0 && res.stdout.includes("/")) {
              const lines = res.stdout.trim().split("\n");
              const lastLine = lines[lines.length - 1]?.trim();
              if (lastLine && lastLine.includes("/") && !lastLine.includes("No activities found")) {
                resolvedActivity = lastLine;
              }
            }
          } catch {}

          if (resolvedActivity) {
            try {
              const res = await execAdb(["-s", target.serial, "shell", "am", "start", "-n", resolvedActivity]);
              if (res.exitCode === 0 && !res.stderr.includes("Error: Activity class") && !res.stdout.includes("Error: Activity class")) {
                startSuccess = true;
              }
            } catch {}
          }

          // Fallback to monkey launcher if resolve-activity was not found or am start failed
          if (!startSuccess) {
            usedMonkey = true;
            const res = await execAdb([
              "-s", target.serial, "shell", "monkey", "-p", args.package, "-c", "android.intent.category.LAUNCHER", "1"
            ]);
            if (res.exitCode === 0 && !res.stdout.includes("No activities found") && !res.stderr.includes("No activities found")) {
              startSuccess = true;
            }
          }
        }

        if (!startSuccess) {
          throw new AppNotFoundError(args.package);
        }

        return {
          package: args.package,
          started: true,
          ...(usedMonkey ? { launcher: true } : {}),
        };
      },
    },
    {
      name: "app.stop",
      domain: "app",
      description: "Force stop specified application",
      inputSchema: z.object({
        package: z.string().describe("Package name to stop"),
      }),
      outputSchema: z.object({
        package: z.string(),
        stopped: z.boolean(),
      }),
      safety: "interactive",
      expect: {
        schema: z.object({ stopped: z.literal(true) }),
      },
      handler: async (ctx, args) => {
        const { target } = await selectTargetDevice(ctx.serial);
        ctx.serial = target.serial;

        await execAdb(["-s", target.serial, "shell", "am", "force-stop", args.package]);
        return { package: args.package, stopped: true };
      },
    },
    {
      name: "app.list",
      domain: "app",
      description: "List installed third-party or system packages",
      inputSchema: z.object({
        third_party_only: z.boolean().optional().default(true),
      }),
      outputSchema: z.object({
        packages: z.array(z.string()),
      }),
      safety: "read",
      handler: async (ctx, args) => {
        const { target } = await selectTargetDevice(ctx.serial);
        ctx.serial = target.serial;

        const cmd = args.third_party_only
          ? ["-s", target.serial, "shell", "pm", "list", "packages", "-3"]
          : ["-s", target.serial, "shell", "pm", "list", "packages"];

        const { stdout } = await execAdb(cmd);
        const IGNORED_PACKAGES = [
          /^com\.github\.uiautomator(\.test)?$/,
          /^Mono\.Android/,
          /^com\.google\.android\.safetycore$/,
          /^com\.amazon\.aa\.attribution$/,
        ];

        const packages = stdout
          .split("\n")
          .map((l) => l.trim().replace(/^package:/, ""))
          .filter((pkg) => Boolean(pkg) && !IGNORED_PACKAGES.some((re) => re.test(pkg)));

        return { packages };
      },
    },
  ],
};
