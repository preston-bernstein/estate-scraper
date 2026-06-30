import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readScanState } from "../scan/state.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT = resolve(__dir, "../scan/index.js");

export function startScan(): { started: boolean; reason?: string } {
  const state = readScanState();
  if (state.running) {
    return { started: false, reason: "already running" };
  }

  const child = spawn(process.execPath, [SCAN_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  return { started: true };
}
