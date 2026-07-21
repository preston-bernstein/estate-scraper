#!/usr/bin/env tsx
/**
 * RunPod vision backend calibration script.
 *
 * Compares a candidate (e.g. RunPod) reference-pass JSON against a frozen
 * baseline (e.g. Gemini) reference-pass JSON — both produced via
 * `npm run scan -- --reference <path>` — matching records by `imageUrl`,
 * and reports:
 *
 *   - "backend agreement rate": (matched records where BOTH baseline and
 *     candidate have hasFindings=true) / (baseline records with
 *     hasFindings=true). Deliberately NOT called "recall@K" — ADR-0010
 *     already uses that name for a different, top-K ranking-cutoff metric
 *     (Tier 1's rank vs. the frozen reference pass); this metric has no
 *     K/cutoff, it's a full-set agreement rate between two backends over
 *     the same image set. See docs/runpod-vision-cutover/plan.md, Design
 *     decisions.
 *   - per-image latency (p50/p95/avg) computed over the candidate's
 *     `durationS` field, with cold-start (the very first candidate record)
 *     reported separately from steady-state (everything after it) — a
 *     serverless 32B-class vision model likely has non-trivial cold-start
 *     time that a blended average would hide.
 *   - throughput (images/second), computed from an operator-supplied
 *     --elapsed-s wall-clock figure, NOT summed per-image durations
 *     (summing would overstate wall-clock time under concurrent
 *     VISION_WORKERS).
 *
 * Usage:
 *   npm run calibrate:runpod -- --baseline <path> --candidate <path> --elapsed-s <seconds>
 *   npm run calibrate:runpod -- --help
 */

import { readFileSync } from "node:fs";

// Mirrors api/src/scan/index.ts's ReferenceRecord shape. Not imported from
// there on purpose: that type isn't exported, and importing scan/index.ts
// would execute its top-level main() (runMigrations/scrape/scan) as a side
// effect of the import. Keep this in sync by hand if ReferenceRecord's
// shape there changes.
type ReferenceRecord = {
  saleId: string;
  saleTitle: string;
  saleUrl: string;
  imageUrl: string;
  positionIndex: number;
  total: number;
  response: string;
  hasFindings: boolean;
  error: string;
  durationS: number;
  backend: string;
};

type Args = {
  baseline: string | null;
  candidate: string | null;
  elapsedS: number | null;
  help: boolean;
};

const USAGE = `
Usage: calibrate-runpod --baseline <path> --candidate <path> --elapsed-s <seconds>

Compares a candidate (e.g. RunPod) reference-pass JSON against a frozen
baseline (e.g. Gemini) reference-pass JSON. Both files are arrays of
ReferenceRecord, as written by \`npm run scan -- --reference <path>\`.

Options:
  --baseline <path>    Path to the baseline (e.g. Gemini) reference JSON. Required.
  --candidate <path>   Path to the candidate (e.g. RunPod) reference JSON. Required.
  --elapsed-s <secs>   Wall-clock seconds for the candidate run, used for throughput. Required.
  --help               Show this message and exit.

Reports: backend agreement rate (not recall@K — see ADR-0010's own, different
top-K metric), per-image latency (p50/p95/avg, cold-start reported separately
from steady-state), and throughput (images/second).
`;

function parseArgs(argv: string[]): Args {
  const args: Args = { baseline: null, candidate: null, elapsedS: null, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--baseline") {
      args.baseline = argv[++index] ?? null;
    } else if (arg === "--candidate") {
      args.candidate = argv[++index] ?? null;
    } else if (arg === "--elapsed-s") {
      const raw = argv[++index];
      const value = Number(raw);
      if (raw === undefined || !Number.isFinite(value)) {
        throw new Error(`--elapsed-s requires a numeric value, got: ${raw ?? "(missing)"}`);
      }
      args.elapsedS = value;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

function loadRecords(path: string): ReferenceRecord[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON array of ReferenceRecord`);
  }
  return parsed as ReferenceRecord[];
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[rank]!;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

type LatencyStats = {
  coldStartS: number | null;
  steadyState: { p50: number; p95: number; avg: number; count: number };
};

// Cold-start is the first candidate record alone; steady-state stats are
// computed over everything after it, per plan.md's Integration points
// (a blended average would hide serverless cold-start cost).
function computeLatencyStats(candidate: ReferenceRecord[]): LatencyStats {
  const coldStartS = candidate.length > 0 ? candidate[0]!.durationS : null;
  const rest = candidate.slice(1).map((r) => r.durationS);
  const sortedRest = [...rest].sort((a, b) => a - b);
  return {
    coldStartS,
    steadyState: {
      p50: percentile(sortedRest, 50),
      p95: percentile(sortedRest, 95),
      avg: mean(rest),
      count: rest.length,
    },
  };
}

type AgreementStats = {
  baselineHasFindingsCount: number;
  matchedBothHasFindings: number;
  rate: number;
  matchedCount: number;
  unmatchedBaselineCount: number;
};

// "Backend agreement rate" — see the file-header comment for why this is
// not named recall@K.
function computeAgreement(baseline: ReferenceRecord[], candidate: ReferenceRecord[]): AgreementStats {
  const candidateByUrl = new Map(candidate.map((r) => [r.imageUrl, r]));
  const baselineHasFindingsRecords = baseline.filter((r) => r.hasFindings);

  let matchedCount = 0;
  let matchedBothHasFindings = 0;
  let unmatchedBaselineCount = 0;

  for (const b of baselineHasFindingsRecords) {
    const c = candidateByUrl.get(b.imageUrl);
    if (!c) {
      unmatchedBaselineCount += 1;
      continue;
    }
    matchedCount += 1;
    if (c.hasFindings) matchedBothHasFindings += 1;
  }

  const rate =
    baselineHasFindingsRecords.length > 0
      ? matchedBothHasFindings / baselineHasFindingsRecords.length
      : 0;

  return {
    baselineHasFindingsCount: baselineHasFindingsRecords.length,
    matchedBothHasFindings,
    rate,
    matchedCount,
    unmatchedBaselineCount,
  };
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function printSummary(
  baselinePath: string,
  candidatePath: string,
  baseline: ReferenceRecord[],
  candidate: ReferenceRecord[],
  agreement: AgreementStats,
  latency: LatencyStats,
  elapsedS: number,
): void {
  const throughput = candidate.length / elapsedS;

  console.log("\nRunPod Vision Backend Calibration");
  console.log("==================================\n");

  console.log("Record counts");
  console.log("-------------");
  console.log(
    `  baseline  (${baselinePath}): ${baseline.length} records, ${agreement.baselineHasFindingsCount} with hasFindings=true`,
  );
  console.log(`  candidate (${candidatePath}): ${candidate.length} records`);
  if (agreement.unmatchedBaselineCount > 0) {
    console.log(
      `  WARNING: ${agreement.unmatchedBaselineCount} baseline hasFindings=true image(s) had no matching imageUrl in candidate`,
    );
  }
  console.log();

  console.log("Backend agreement rate");
  console.log("-----------------------");
  console.log(
    `  (matched hasFindings on both) / (baseline hasFindings) = ${agreement.matchedBothHasFindings}/${agreement.baselineHasFindingsCount} = ${fmt(agreement.rate)}`,
  );
  console.log(
    `  Note: this is "backend agreement rate", distinct from ADR-0010's own recall@K (a top-K ranking-cutoff metric).`,
  );
  console.log();

  console.log("Latency (candidate durationS, seconds)");
  console.log("---------------------------------------");
  console.log(
    `  cold-start (first image):     ${latency.coldStartS !== null ? `${fmt(latency.coldStartS)}s` : "n/a (no candidate records)"}`,
  );
  console.log(`  steady-state (remaining ${latency.steadyState.count} image(s)):`);
  console.log(`    p50: ${fmt(latency.steadyState.p50)}s`);
  console.log(`    p95: ${fmt(latency.steadyState.p95)}s`);
  console.log(`    avg: ${fmt(latency.steadyState.avg)}s`);
  console.log();

  console.log("Throughput");
  console.log("----------");
  console.log(
    `  ${candidate.length} images / ${elapsedS}s elapsed (operator-supplied --elapsed-s) = ${fmt(throughput)} images/sec`,
  );
  console.log();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const missing: string[] = [];
  if (!args.baseline) missing.push("--baseline");
  if (!args.candidate) missing.push("--candidate");
  if (args.elapsedS === null) missing.push("--elapsed-s");
  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.join(", ")}`);
    console.log(USAGE);
    process.exit(1);
  }

  const baseline = loadRecords(args.baseline!);
  const candidate = loadRecords(args.candidate!);

  const agreement = computeAgreement(baseline, candidate);
  const latency = computeLatencyStats(candidate);

  printSummary(args.baseline!, args.candidate!, baseline, candidate, agreement, latency, args.elapsedS!);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
