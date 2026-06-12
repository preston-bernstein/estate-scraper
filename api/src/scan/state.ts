import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SCAN_STATE_PATH } from "../lib/constants.js";

export type ScanPhase = "idle" | "scraping" | "analyzing" | "done";

export type ScanState = {
  running: boolean;
  phase: ScanPhase;
  message: string;
  failed: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  events: Record<string, unknown>[];
};

const DEFAULT_STATE: ScanState = {
  running: false,
  phase: "idle",
  message: "",
  failed: false,
  startedAt: null,
  finishedAt: null,
  events: [],
};

function ensureStateDir() {
  mkdirSync(dirname(SCAN_STATE_PATH), { recursive: true });
}

export function readScanState(): ScanState {
  try {
    const raw = readFileSync(SCAN_STATE_PATH, "utf8");
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as ScanState) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeScanState(state: ScanState) {
  ensureStateDir();
  writeFileSync(SCAN_STATE_PATH, JSON.stringify(state, null, 2));
}

export class ScanStateWriter {
  private state: ScanState;

  constructor() {
    this.state = {
      ...DEFAULT_STATE,
      running: true,
      startedAt: new Date().toISOString(),
      events: [],
    };
    writeScanState(this.state);
  }

  setPhase(phase: ScanPhase, message: string) {
    this.state.phase = phase;
    this.state.message = message;
    writeScanState(this.state);
  }

  pushEvent(event: Record<string, unknown>) {
    this.state.events.push(event);
    writeScanState(this.state);
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
