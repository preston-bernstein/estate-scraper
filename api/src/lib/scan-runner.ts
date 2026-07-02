import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { markScanFailed, markScanStarting, readScanState } from "../scan/state.js";

const __dir = dirname(fileURLToPath(import.meta.url));
// Manual trigger is a production feature (the scheduled scan runs the built artifact);
// resolve to the compiled entry point. Under `npm run dev` (tsx on src/) this .js
// won't exist — the child's error handler below surfaces that instead of crashing.
const SCAN_SCRIPT = resolve(__dir, "../scan/index.js");

export function startScan(): { started: boolean; reason?: string } {
  const state = readScanState();
  if (state.running) {
    return { started: false, reason: "already running" };
  }

  // Claim the run synchronously before spawning. This runs to completion without an
  // await, so two concurrent /scan/start requests in the same process can't both pass
  // the check above and double-spawn.
  markScanStarting();

  const child = spawn(process.execPath, [SCAN_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  // Without this, a spawn failure (e.g. ENOENT on the built script) emits an
  // unhandled 'error' event that crashes the API process.
  child.on("error", (err) => {
    markScanFailed(`Failed to start scan: ${err.message}`);
  });

  child.unref();

  return { started: true };
}
