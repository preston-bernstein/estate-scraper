import { readFile } from "node:fs/promises";
import { EMBED_MODEL, embedImages, embeddingEnabled, float32ToBlob } from "../lib/embed.js";
import { getImagesNeedingEmbedding, updateImageEmbedding } from "./persist.js";

// Read thumbnails from disk this many at a time so the whole corpus isn't held in
// memory at once; embedImages() does its own request-level batching within a chunk.
const READ_CHUNK = 256;

// Post-scan embedding pass (ADR 0013, 0016). Embeds from the persisted thumbnail —
// the canonical re-embed source — so it never re-downloads the (soon-dead) CDN URL,
// is idempotent (only fills NULL embeddings), and resumes after a crash. The same
// function is the re-embed migration when the frozen model changes: null the column
// and run it again. No-op when EMBED_API_BASE is unset.
export async function embedPendingImages(): Promise<{
  embedded: number;
  failed: number;
  skipped: boolean;
}> {
  if (!embeddingEnabled()) return { embedded: 0, failed: 0, skipped: true };

  const pending = await getImagesNeedingEmbedding();
  if (pending.length === 0) return { embedded: 0, failed: 0, skipped: false };

  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i += READ_CHUNK) {
    const chunk = pending.slice(i, i + READ_CHUNK);
    const buffers = await Promise.all(
      chunk.map(async (row) => {
        try {
          return await readFile(row.thumbnailPath);
        } catch {
          return null; // thumbnail missing on disk — count as failed below
        }
      }),
    );

    const readable: Array<{ id: number; buf: Buffer }> = [];
    for (let j = 0; j < chunk.length; j++) {
      const buf = buffers[j];
      if (buf) readable.push({ id: chunk[j]!.id, buf });
    }
    failed += chunk.length - readable.length;

    const vecs = await embedImages(readable.map((x) => x.buf));
    for (let j = 0; j < readable.length; j++) {
      const vec = vecs[j];
      if (!vec) {
        failed++;
        continue;
      }
      // Stamp the actual returned dimension (ADR 0016) — the frozen-model guard in
      // embed.ts has already rejected any vector of the wrong size.
      await updateImageEmbedding(readable[j]!.id, float32ToBlob(vec), EMBED_MODEL, vec.length);
      embedded++;
    }

    console.log(
      `  [embed] ${Math.min(i + READ_CHUNK, pending.length)}/${pending.length} processed — ${embedded} embedded, ${failed} failed`,
    );
  }

  return { embedded, failed, skipped: false };
}
