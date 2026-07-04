// Image embedding via an OpenAI-compatible /embeddings endpoint (ADR 0013, 0016).
//
// The endpoint is left configurable so the serving stack (Infinity, TEI, vLLM, a
// custom SigLIP server) can change without touching this code — the OpenAI wire
// format is the stable contract. Point EMBED_API_BASE at the broker batch port in
// production so the shared GPU is arbitrated, never at raw Ollama.
//
// The embedding model is FROZEN (ADR 0016): every vector in the images.embedding
// BLOB column must live in one geometry. EMBED_DIM, when set, is the guard — a
// response of the wrong dimension is rejected rather than silently poisoning the
// column with a vector from a different model.

export const EMBED_API_BASE = process.env.EMBED_API_BASE ?? "";
const EMBED_API_KEY = process.env.EMBED_API_KEY ?? "";
// SigLIP so400m: 1152-dim. Override per the frozen choice via env.
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "siglip-so400m-patch14-384";
const EMBED_DIM = process.env.EMBED_DIM ? Number(process.env.EMBED_DIM) : null;
// Images per /embeddings request (server batches these onto the GPU together).
const EMBED_BATCH = Number(process.env.EMBED_BATCH ?? 16);
// Concurrent in-flight batch requests.
const EMBED_WORKERS = Number(process.env.EMBED_WORKERS ?? 2);
// Short timeout for query embedding (Phase 2 hybrid search) — this sits on a live
// user-facing search request, unlike the 120s batch-scan timeout above, so a slow
// endpoint must fail fast and fall back to lexical-only results (AC5).
export const EMBED_SEARCH_TIMEOUT_MS = Number(process.env.EMBED_SEARCH_TIMEOUT_MS ?? 3000);
// Server-side cap on query text sent for embedding (NFR: bound token cost of any
// single search request).
const EMBED_QUERY_MAX_CHARS = 200;

export function embeddingEnabled(): boolean {
  return EMBED_API_BASE.length > 0;
}

// Pack a vector as little-endian float32 for the SQLite BLOB column. Round-trips
// with blobToFloat32 below — both sides assume little-endian, matching x86/ARM.
export function float32ToBlob(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i]!, i * 4);
  return buf;
}

export function blobToFloat32(buf: Buffer): number[] {
  const out = new Array<number>(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

type EmbedResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
};

// Parse an OpenAI /embeddings response into a dense array ordered by `index`,
// enforcing the frozen-dimension guard. Exported for unit testing the wire
// contract without a live endpoint. Returns one entry per input; null = rejected.
export function parseEmbedResponse(
  payload: EmbedResponse,
  count: number,
  dim: number | null = EMBED_DIM,
): (number[] | null)[] {
  const out: (number[] | null)[] = new Array(count).fill(null);
  for (const [i, item] of (payload.data ?? []).entries()) {
    const idx = item.index ?? i;
    const vec = item.embedding;
    if (!vec || idx < 0 || idx >= count) continue;
    if (dim !== null && vec.length !== dim) {
      console.error(
        `  [embed] dim mismatch: got ${vec.length}, expected ${dim} — vector rejected (frozen-model guard)`,
      );
      continue;
    }
    out[idx] = vec;
  }
  return out;
}

async function embedBatch(dataUris: string[]): Promise<(number[] | null)[]> {
  try {
    const response = await fetch(`${EMBED_API_BASE}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(EMBED_API_KEY ? { Authorization: `Bearer ${EMBED_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: dataUris }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      console.error(`  [embed] HTTP ${response.status} — batch of ${dataUris.length} skipped`);
      return new Array(dataUris.length).fill(null);
    }
    const payload = (await response.json()) as EmbedResponse;
    return parseEmbedResponse(payload, dataUris.length);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.error(`  [embed] request failed (${msg}) — batch of ${dataUris.length} skipped`);
    return new Array(dataUris.length).fill(null);
  }
}

// Embed a list of JPEG buffers. Returns one (vector | null) per input, in order;
// null means that image failed or was rejected (fail-open — the caller keeps the
// thumbnail and leaves embedding NULL, so a later pass can retry). Batched and
// concurrency-limited so the shared GPU isn't flooded.
export async function embedImages(buffers: Buffer[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(buffers.length).fill(null);
  const batches: Array<{ start: number; uris: string[] }> = [];
  for (let i = 0; i < buffers.length; i += EMBED_BATCH) {
    const slice = buffers.slice(i, i + EMBED_BATCH);
    batches.push({
      start: i,
      uris: slice.map((b) => `data:image/jpeg;base64,${b.toString("base64")}`),
    });
  }

  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const { start, uris } = batches[next++]!;
      const vecs = await embedBatch(uris);
      for (let j = 0; j < vecs.length; j++) results[start + j] = vecs[j]!;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(EMBED_WORKERS, batches.length) }, () => worker()),
  );
  return results;
}

// Embed a single free-text search query into the same SigLIP vector space as
// Image embeddings (Phase 2 hybrid search, ADR 0016/0017). Distinct from
// embedImages: single-string input, a short request timeout (EMBED_SEARCH_TIMEOUT_MS,
// not the 120s batch timeout), and a hard cap on input length. Never throws — any
// failure (disabled, timeout, HTTP error, dim mismatch) returns null so the caller
// can fall back to lexical-only search. NEVER logs the raw query text (secrets/
// logging requirement) — only status/outcome, matching embedBatch's convention.
export async function embedQueryText(text: string): Promise<number[] | null> {
  if (!embeddingEnabled()) return null;

  const capped = text.slice(0, EMBED_QUERY_MAX_CHARS);
  if (capped.trim().length === 0) return null;

  try {
    const response = await fetch(`${EMBED_API_BASE}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(EMBED_API_KEY ? { Authorization: `Bearer ${EMBED_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: capped }),
      signal: AbortSignal.timeout(EMBED_SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`  [embed] query embed HTTP ${response.status} — discarded`);
      return null;
    }
    const payload = (await response.json()) as EmbedResponse;
    const [vec] = parseEmbedResponse(payload, 1);
    if (!vec) {
      console.error("  [embed] query embed rejected (missing or dim mismatch)");
      return null;
    }
    return vec;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.error(`  [embed] query embed failed (${msg}) — falling back to lexical`);
    return null;
  }
}
