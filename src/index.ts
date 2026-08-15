#!/usr/bin/env bun
import { runCli } from "./cli";

if (process.platform === "win32") {
  process.env.BUN_FORCE_UTF8 = "1";
}

const exitCode = await runCli(Bun.argv.slice(2));
process.exit(exitCode);

