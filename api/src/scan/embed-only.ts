// Standalone image-embedding pass (ADR 0013/0016) — the post-scan embed step
// decoupled from a full scrape. Use it to backfill the corpus after the embed
// endpoint is first configured, to re-embed after the frozen model changes
// (null the images.embedding column, then run this), or to verify the endpoint
// without hitting estatesales.net. Idempotent: only fills NULL embeddings.
//
//   EMBED_API_BASE=... npm run embed -w api
//
// No-op (clean exit) when EMBED_API_BASE is unset.
import { runMigrations } from "../db/index.js";
import { EMBED_API_BASE, EMBED_MODEL, embeddingEnabled } from "../lib/embed.js";
import { embedPendingImages } from "./embed-pass.js";

async function main() {
  if (!embeddingEnabled()) {
    console.log("[embed] EMBED_API_BASE not set — nothing to do.");
    return;
  }
  runMigrations();
  console.log(`[embed] endpoint=${EMBED_API_BASE} model=${EMBED_MODEL}`);
  const result = await embedPendingImages();
  if (result.skipped) {
    console.log("[embed] skipped — EMBED_API_BASE not set.");
    return;
  }
  console.log(`[embed] done — ${result.embedded} embedded, ${result.failed} failed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
