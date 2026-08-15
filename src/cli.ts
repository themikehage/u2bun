import { resolveConfig, type Config } from "./config";
import { formatSuccessEnvelope, formatErrorEnvelope, renderOutput } from "./output";
import { U2Error, UsageError, InternalError } from "./errors";
import { registry, type HandlerContext } from "./registry";
import { DOMAINS } from "./domains";

// Register all domains at startup
for (const domain of DOMAINS) {
  registry.registerDomain(domain);
}

export function parseArgs(rawArgs: string[]): {
  configFlags: Partial<Config>;
  domain?: string;
  subcommand?: string;
  toolArgs: Record<string, unknown>;
  showHelp: boolean;
  showVersion: boolean;
} {
  const configFlags: Partial<Config> = {};
  const toolArgs: Record<string, unknown> = {};
  const positional: string[] = [];
  let showHelp = false;
  let showVersion = false;

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      i++;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      showVersion = true;
      i++;
      continue;
    }

    if (arg === "--serial") {
      configFlags.serial = rawArgs[++i];
    } else if (arg.startsWith("--serial=")) {
      configFlags.serial = arg.split("=", 2)[1];
    } else if (arg === "--safety") {
      configFlags.safety = rawArgs[++i] as any;
    } else if (arg.startsWith("--safety=")) {
      configFlags.safety = arg.split("=", 2)[1] as any;
    } else if (arg === "--timeout") {
      configFlags.timeout = Number(rawArgs[++i]);
    } else if (arg.startsWith("--timeout=")) {
      configFlags.timeout = Number(arg.split("=", 2)[1]);
    } else if (arg === "--quiet") {
      configFlags.quiet = true;
    } else if (arg === "--debug") {
      configFlags.debug = true;
    } else if (arg === "--json") {
      configFlags.json = true;
    } else if (arg === "--strict-selector") {
      configFlags.strictSelector = true;
    } else if (arg.startsWith("--no-")) {
      const key = toSnakeCase(arg.slice(5));
      toolArgs[key] = false;
    } else if (arg.startsWith("--")) {
      const param = arg.slice(2);
      if (param.includes("=")) {
        const [k, v] = param.split("=", 2);
        toolArgs[toSnakeCase(k)] = parseTypedValue(v);
      } else {
        const next = rawArgs[i + 1];
        if (next !== undefined && (!next.startsWith("-") || next.startsWith("@") || /^-?\d+$/.test(next))) {
          toolArgs[toSnakeCase(param)] = parseTypedValue(next);
          i++;
        } else {
          toolArgs[toSnakeCase(param)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
    i++;
  }

  const [domain, subcommand] = positional;

  return {
    configFlags,
    domain,
    subcommand,
    toolArgs,
    showHelp,
    showVersion,
  };
}

function toSnakeCase(str: string): string {
  return str.replace(/-/g, "_");
}

function parseTypedValue(val: string): unknown {
  if (val === "true") return true;
  if (val === "false") return false;
  if (!isNaN(Number(val)) && val.trim() !== "") return Number(val);
  return val;
}

export function printHelp(): void {
  console.log(`u2bun - Android UI Automator Control CLI (Bun rewrite)

Usage:
  u2bun [--serial SERIAL] [--safety LEVEL] [--timeout SECONDS] [--quiet] <domain> <command> [options]

Domains & Commands:
${registry
  .listDomains()
  .map(
    (d) =>
      `  ${d.name.padEnd(12)} ${d.description}\n` +
      d.tools.map((t) => `    ${t.name.split(".", 2)[1].padEnd(14)} ${t.description}`).join("\n")
  )
  .join("\n\n")}

Global Options:
  --serial SERIAL       Target device ADB serial
  --safety LEVEL        Safety ceiling: read | interactive | destructive (default: destructive)
  --timeout SECONDS     Global timeout (default: 30)
  --quiet               Suppress diagnostic stderr output
  --strict-selector     Fail on ambiguous selector matches
  --json                Emit standard machine-readable JSON envelope
  --help, -h            Show help message
  --version, -v         Show version
`);
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const config = resolveConfig(parsed.configFlags);

  if (parsed.showVersion) {
    console.log("u2bun 0.1.0 (Bun)");
    return 0;
  }

  if (parsed.showHelp || (!parsed.domain && !parsed.subcommand)) {
    printHelp();
    return 0;
  }

  const domainName = parsed.domain;
  const subName = parsed.subcommand;
  const toolName = `${domainName}.${subName?.replace(/-/g, "_")}`;

  const tool = registry.getTool(toolName);
  if (!tool) {
    const err = new UsageError(`Unknown command '${domainName} ${subName || ""}'. Use --help for available commands.`);
    const envelope = formatErrorEnvelope(toolName, err, config.serial);
    renderOutput(envelope, config.quiet, config.json);
    return err.exitCode;
  }

  // Enforce safety ceiling (G7)
  const safetyOrder: Record<string, number> = { read: 0, interactive: 1, destructive: 2 };
  if (safetyOrder[tool.safety || "read"] > safetyOrder[config.safety]) {
    const err = new UsageError(
      `Tool '${tool.name}' requires safety level '${tool.safety}', but ceiling is locked to '${config.safety}'`
    );
    const envelope = formatErrorEnvelope(tool.name, err, config.serial);
    renderOutput(envelope, config.quiet, config.json);
    return err.exitCode;
  }

  const warnings: string[] = [];
  const ctx: HandlerContext = {
    serial: config.serial,
    timeout: config.timeout,
    debug: config.debug,
    warnings,
    warn: (msg: string) => warnings.push(msg),
    callTool: async (name: string, args: Record<string, unknown>) => {
      const subTool = registry.getTool(name);
      if (!subTool) throw new InternalError(`Delegated tool '${name}' not found`);
      const validatedInput = subTool.inputSchema.parse(args);
      const res = await subTool.handler(ctx, validatedInput);
      return subTool.outputSchema.parse(res) as Record<string, unknown>;
    },
  };

  try {
    const validatedArgs = tool.inputSchema.parse(parsed.toolArgs);
    const result = await tool.handler(ctx, validatedArgs);
    const validatedResult = tool.outputSchema.parse(result) as Record<string, unknown>;

    await registry.verifyPostcondition(ctx, tool, validatedResult);

    const envelope = formatSuccessEnvelope(tool.name, ctx.serial, validatedResult, warnings);
    renderOutput(envelope, config.quiet, config.json);
    return 0;
  } catch (error: any) {
    let uError: U2Error;
    if (error instanceof U2Error) {
      uError = error;
    } else if (error?.name === "ZodError") {
      uError = new UsageError(`Validation error: ${error.message}`);
    } else {
      uError = new InternalError(error.message || String(error));
    }

    const envelope = formatErrorEnvelope(tool.name, uError, ctx.serial, warnings);
    renderOutput(envelope, config.quiet, config.json);
    return uError.exitCode;
  }
}
