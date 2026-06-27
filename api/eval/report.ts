import type { Category, ImageResult, RunSummary } from "./types.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function colorPct(n: number): string {
  const s = pct(n);
  if (n >= 0.8) return `${GREEN}${s}${RESET}`;
  if (n >= 0.5) return `${YELLOW}${s}${RESET}`;
  return `${RED}${s}${RESET}`;
}

function tick(v: boolean | null): string {
  if (v === null) return `${DIM}n/a${RESET}`;
  return v ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
}

function ms(n: number): string {
  return `${(n / 1000).toFixed(1)}s`;
}

function pad(s: string, width: number): string {
  // strip ANSI for length calculation
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, width - plain.length));
}

const CAT_ORDER: Category[] = ["seating", "bed", "case_goods", "collectible", "nothing"];

export function printSummary(summary: RunSummary): void {
  console.log();
  console.log(`${BOLD}${CYAN}── ${summary.model} / prompt:${summary.promptName} ──${RESET}`);
  console.log();

  // Top-line metrics
  const metrics = [
    ["Detection accuracy", colorPct(summary.detectionAcc)],
    ["Keyword recall", colorPct(summary.keywordRecall)],
    ["Specificity (seating/bed)", summary.specificityRate > 0 || summary.totalImages > 0 ? colorPct(summary.specificityRate) : `${DIM}n/a${RESET}`],
    ["Format compliance", colorPct(summary.formatCompliance)],
    ["Avg latency / image", `${DIM}${ms(summary.avgDurationMs)}${RESET}`],
    ["Images evaluated", `${DIM}${summary.totalImages}${RESET}`],
  ];

  for (const [label, value] of metrics) {
    console.log(`  ${pad(label, 28)} ${value}`);
  }

  // Per-category table
  console.log();
  console.log(`  ${BOLD}${pad("Category", 14)}${pad("Detect", 10)}${pad("Keyword", 10)}${pad("Specific", 10)}${pad("Format", 8)}${RESET}`);
  console.log("  " + "─".repeat(50));

  const sorted = [...summary.byCategory].sort(
    (a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category),
  );

  for (const cat of sorted) {
    const detect = `${cat.detected}/${cat.total}`;
    const keyword = `${cat.keywordHit}/${cat.total}`;
    const specific = cat.specificTotal > 0 ? `${cat.specific}/${cat.specificTotal}` : "n/a";
    const format = `${cat.formatOk}/${cat.total}`;

    console.log(
      `  ${pad(cat.category, 14)}` +
        `${pad(detect, 10)}${pad(keyword, 10)}${pad(specific, 10)}${pad(format, 8)}`,
    );
  }
}

export function printComparison(summaries: RunSummary[]): void {
  console.log();
  console.log(`${BOLD}${CYAN}═══ Comparison Report ═══${RESET}`);

  const colW = 24;
  const labelW = 30;

  // Header row
  const header =
    " ".repeat(labelW) + summaries.map((s) => pad(`${s.model}/${s.promptName}`, colW)).join("");
  console.log(`${BOLD}${header}${RESET}`);
  console.log("─".repeat(labelW + colW * summaries.length));

  const rows: [string, (s: RunSummary) => string][] = [
    ["Detection accuracy", (s) => colorPct(s.detectionAcc)],
    ["Keyword recall", (s) => colorPct(s.keywordRecall)],
    ["Specificity (seating/bed)", (s) => colorPct(s.specificityRate)],
    ["Format compliance", (s) => colorPct(s.formatCompliance)],
    ["Avg latency / image", (s) => ms(s.avgDurationMs)],
  ];

  for (const [label, fn] of rows) {
    const cols = summaries.map((s) => pad(fn(s), colW)).join("");
    console.log(`${pad(label, labelW)}${cols}`);
  }

  console.log();
}

export function printImageResults(results: ImageResult[]): void {
  console.log();
  console.log(`${BOLD}Per-image breakdown${RESET}`);
  console.log("─".repeat(80));

  for (const r of results) {
    const statusIcon = r.error
      ? `${RED}ERR${RESET}`
      : r.detected === !r.label.expectNothing
        ? `${GREEN}✓${RESET}`
        : `${RED}✗${RESET}`;

    const shortUrl = r.label.url.replace("https://picturescdn.estatesales.net/", "…/");
    console.log();
    console.log(
      `[${statusIcon}] ${BOLD}${r.label.category}${RESET}  ${DIM}${shortUrl}${RESET}`,
    );
    console.log(`    ${DIM}${r.label.notes}${RESET}`);

    if (r.error) {
      console.log(`    ${RED}Error: ${r.error}${RESET}`);
      continue;
    }

    const rawDisplay = r.raw.length > 120 ? r.raw.slice(0, 120) + "…" : r.raw;
    console.log(`    Got:      "${rawDisplay}"`);
    console.log(
      `    detected:${tick(r.detected === !r.label.expectNothing)}  keyword:${tick(r.keywordHit)}  specific:${tick(r.specific)}  format:${tick(r.formatOk)}  ${DIM}${ms(r.durationMs)}${RESET}`,
    );
  }
}
