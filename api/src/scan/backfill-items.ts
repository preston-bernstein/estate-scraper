import { runMigrations } from "../db/index.js";
import { backfillFindingItems } from "./persist.js";

// One-off: populate finding_items for findings that predate item extraction, and the
// re-mine path after the lexicon grows (delete finding_items rows first, then run).
// Idempotent — findings that already have items are skipped.
async function main() {
  runMigrations();
  console.log("Backfilling finding_items…");
  const { findings, items } = await backfillFindingItems();
  console.log(`Done — ${items} items across ${findings} findings.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
