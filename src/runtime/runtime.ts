import { execAdb } from "./adb";
import { RuntimeDownError } from "../errors";
import { U2Client } from "./u2client";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const U2_JAR_REMOTE_PATH = "/data/local/tmp/u2.jar";
// Fallback download URL for u2.jar from openatx uiautomator2 releases if missing locally
const U2_JAR_DOWNLOAD_URL = "https://github.com/openatx/uiautomator2/releases/download/v2.13.0/u2.jar";

export async function isAdbHealthy(serial: string, adbPath?: string): Promise<boolean> {
  try {
    const { exitCode } = await execAdb(["-s", serial, "shell", "getprop", "ro.build.version.sdk"], adbPath);
    return exitCode === 0;
  } catch {
    return false;
  }
}

export async function isU2JarPresent(serial: string, adbPath?: string): Promise<boolean> {
  try {
    const { stdout, exitCode } = await execAdb(["-s", serial, "shell", "ls", U2_JAR_REMOTE_PATH], adbPath);
    return exitCode === 0 && stdout.includes("u2.jar") && !stdout.includes("No such file");
  } catch {
    return false;
  }
}

export async function ensureU2Jar(serial: string, adbPath?: string): Promise<void> {
  if (await isU2JarPresent(serial, adbPath)) {
    return;
  }

  // Check local assets or temp dir
  const localAssetPath = join(import.meta.dir, "../../assets/u2.jar");
  let jarPath = localAssetPath;

  if (!existsSync(localAssetPath)) {
    const tempJarPath = join(tmpdir(), "u2bun-u2.jar");
    if (!existsSync(tempJarPath)) {
      try {
        const res = await fetch(U2_JAR_DOWNLOAD_URL, { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        writeFileSync(tempJarPath, new Uint8Array(buffer));
      } catch (err: any) {
        throw new RuntimeDownError(
          serial,
          `u2.jar missing on device and download failed: ${err.message || String(err)}`
        );
      }
    }
    jarPath = tempJarPath;
  }

  // Push u2.jar to device
  const { exitCode, stderr } = await execAdb(["-s", serial, "push", jarPath, U2_JAR_REMOTE_PATH], adbPath);
  if (exitCode !== 0) {
    throw new RuntimeDownError(serial, `Failed to push u2.jar to device: ${stderr}`);
  }
}

export async function checkU2Readiness(localPort: number, timeoutMs: number = 500): Promise<boolean> {
  try {
    const client = new U2Client(localPort, Math.ceil(timeoutMs / 1000));
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

export async function ensureU2Runtime(
  serial: string,
  localPort: number = 9008,
  adbPath?: string
): Promise<void> {
  // 1. Verify ADB is healthy (distinguishes device offline vs runtime down)
  const adbOk = await isAdbHealthy(serial, adbPath);
  if (!adbOk) {
    throw new Error(`ADB connection to device '${serial}' failed`);
  }

  // 2. Check if runtime ping succeeds right now
  if (await checkU2Readiness(localPort, 500)) {
    return;
  }

  // 3. Ensure u2.jar is present on device
  await ensureU2Jar(serial, adbPath);

  // 4. Start uiautomator2 server in background via app_process
  const launchCmd = `nohup sh -c 'CLASSPATH=${U2_JAR_REMOTE_PATH} app_process / com.wetest.uia2.Main -p ${localPort} > /data/local/tmp/u2.log 2>&1' > /dev/null 2>&1 &`;
  await execAdb(["-s", serial, "shell", launchCmd], adbPath);

  // 5. Poll for readiness (up to 5 seconds)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await checkU2Readiness(localPort, 500)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  throw new RuntimeDownError(serial, "uiautomator2 server did not become ready after auto-start");
}
