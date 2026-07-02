import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SCAN_EVENTS_PATH, SCAN_STATE_PATH } from "../lib/scraping.js";

export type ScanPhase = "idle" | "scraping" | "analyzing" | "done";

// The small, frequently-read status object. Events live in a separate append-only
// NDJSON log (SCAN_EVENTS_PATH) so the status file stays tiny and cheap to rewrite —
// pushing an event never rewrites the whole history (was O(n²) bytes per scan).
export type ScanState = {
  running: boolean;
  phase: ScanPhase;
  message: string;
  failed: boolean;
  startedAt: string | null;
  finishedAt: string | null;
};

const DEFAULT_STATE: ScanState = {
  running: false,
  phase: "idle",
  message: "",
  failed: false,
  startedAt: null,
  finishedAt: null,
};

// Cache of the last successfully-parsed state (per process). A torn read — should be
// impossible now that writes are atomic, but belt-and-suspenders — returns the last
// good value instead of collapsing to "idle", which would kill the SSE stream and
// let startScan() spawn a second concurrent scan.
let lastGoodState: ScanState = { ...DEFAULT_STATE };

function ensureStateDir() {
  mkdirSync(dirname(SCAN_STATE_PATH), { recursive: true });
}

export function readScanState(): ScanState {
  try {
    const raw = readFileSync(SCAN_STATE_PATH, "utf8");
    const parsed = { ...DEFAULT_STATE, ...(JSON.parse(raw) as ScanState) };
    lastGoodState = parsed;
    return parsed;
  } catch {
    return { ...lastGoodState };
  }
}

export function writeScanState(state: ScanState) {
  ensureStateDir();
  // Atomic replace: write to a temp file then rename (atomic on POSIX) so a
  // concurrent reader never observes a half-written file.
  const tmp = `${SCAN_STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, SCAN_STATE_PATH);
}

// Claim a run synchronously (before spawning the child) so a double-clicked
// /scan/start can't spawn two scans in the window before the child boots and writes
// running:true itself. Callable from the API process; the child overwrites this with
// its own fresh state via ScanStateWriter.
export function markScanStarting(message = "Starting scan…") {
  writeScanState({
    ...DEFAULT_STATE,
    running: true,
    phase: "scraping",
    message,
    startedAt: new Date().toISOString(),
  });
}

export function markScanFailed(message: string) {
  writeScanState({ ...readScanState(), running: false, failed: true, message });
}

// Read events appended since `fromIndex` complete lines. A partial trailing line
// (writer mid-append) is excluded — only lines terminated by "\n" are returned.
export function readScanEvents(fromIndex: number): {
  events: Record<string, unknown>[];
  nextIndex: number;
} {
  try {
    const raw = readFileSync(SCAN_EVENTS_PATH, "utf8");
    const parts = raw.split("\n");
    const complete = parts.slice(0, -1); // drop trailing partial/empty segment
    const events: Record<string, unknown>[] = [];
    for (let i = fromIndex; i < complete.length; i++) {
      try {
        events.push(JSON.parse(complete[i]!) as Record<string, unknown>);
      } catch {
        // skip an unparseable line rather than aborting the whole read
      }
    }
    return { events, nextIndex: complete.length };
  } catch {
    return { events: [], nextIndex: fromIndex };
  }
}

export class ScanStateWriter {
  private state: ScanState;

  constructor() {
    this.state = {
      ...DEFAULT_STATE,
      running: true,
      startedAt: new Date().toISOString(),
    };
    ensureStateDir();
    // Truncate the events log so a new scan doesn't replay the previous scan's events.
    writeFileSync(SCAN_EVENTS_PATH, "");
    writeScanState(this.state);
  }

  setPhase(phase: ScanPhase, message: string) {
    this.state.phase = phase;
    this.state.message = message;
    writeScanState(this.state);
  }

  pushEvent(event: Record<string, unknown>) {
    // O(1) append — no full-file rewrite. Append is effectively atomic per line.
    appendFileSync(SCAN_EVENTS_PATH, `${JSON.stringify(event)}\n`);
  }

  finish(message: string, failed = false) {
    this.state.running = false;
    this.state.phase = failed ? this.state.phase : "done";
    this.state.failed = failed;
    this.state.message = message;
    this.state.finishedAt = new Date().toISOString();
    writeScanState(this.state);
  }
}
