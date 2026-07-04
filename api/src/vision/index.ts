import sharp from "sharp";
import {
  LOCAL_GATE_ENABLED,
  LOCAL_GATE_PROMPT,
  LOCAL_GATE_SYSTEM,
  OLLAMA_HOST,
  OLLAMA_MODEL,
  PHASH_HAMMING_THRESHOLD,
  PREFILTER_WORKERS,
  VISION_API_BASE,
  VISION_API_KEY,
  VISION_API_MODEL,
  VISION_SYSTEM_PROMPT,
  VISION_USER_PROMPT,
  VISION_WORKERS,
} from "../lib/vision.js";
import {
  HIGH_SCORE_THRESHOLD,
  LEAD_SAMPLE_PCT,
  ORACLE_API_BASE,
  ORACLE_SCORE_MAX,
  ORACLE_SCORE_MIN,
  SWITCH_SCORE_THRESHOLD,
  TAIL_SAMPLE_K,
  TAIL_SAMPLE_PCT_START,
} from "../lib/sampling.js";
import { fetchBuffer } from "../lib/http.js";
import { writeThumbnail } from "../lib/thumbnails.js";
import type { ScrapedSale } from "../scraper/index.js";

export type AnalysisPhase = "FULL" | "TAIL_PROBE" | "EARLY_STOP";
export type Confidence = "high" | "medium" | "low";

export type VisionEvent =
  | {
      type: "sale_start";
      saleIdx: number;
      totalSales: number;
      saleId: string;
      title: string;
      url: string;
      total: number;
      originalTotal: number;
    }
  | {
      type: "progress";
      saleId: string;
      done: number;
      total: number;
      found: number;
      errors: number;
    }
  | {
      type: "finding";
      saleId: string;
      imageUrl: string;
      description: string;
      confidence: Confidence | null;
      imagePositionPct: number;
      durationS: number;
    }
  | {
      type: "sale_skip";
      saleId: string;
      title: string;
      url: string;
      imagesAnalyzed: number;
      totalImages: number;
    }
  | {
      type: "oracle_request";
      saleId: string;
      title: string;
      address: string;
      imageUrls: string[];
      saleScore: number;
    }
  | {
      type: "sale_done";
      saleId: string;
      title: string;
      url: string;
      imagesProcessed: number;
      imagesWithFindings: number;
      errors: number;
      analysisPhase: AnalysisPhase;
      totalImages: number;
      saleScore: number;
    }
  | {
      // Every analyzed Image (winners AND junk) — the durable corpus row (ADR 0014).
      // phash is the dedup fingerprint computed in stage 1; positionPct is where the
      // Image sat in the listing. Persisted to the images table; junk rows are the
      // negative exemplars the taste ranker trains on. Not emitted in reference mode.
      type: "analyzed_image";
      saleId: string;
      imageUrl: string;
      phash: string | null;
      positionPct: number;
      thumbnailPath: string | null;
      visionResponse: string | null; // raw VLM text; null = gated/skipped/error
    }
  | {
      // Reference mode only — one event per analyzed image, including NOTHING
      // responses. This is the raw material for the frozen reference pass that
      // recall@K is measured against (ADR 0010). Never emitted in normal scans.
      type: "image_result";
      saleId: string;
      imageUrl: string;
      response: string;
      error: string;
      positionIndex: number;
      total: number;
      hasFindings: boolean;
    }
  | { type: "done" };

type ImageResult = {
  url: string;
  saleId: string;
  response: string;
  error: string;
  durationS: number;
  thumbnailPath: string | null;
};

type TaggedResult = ImageResult & { positionIndex: number };

// ─── Response parsing ─────────────────────────────────────────────────────────

// A model line reporting "nothing here" for one category, e.g. "SILVER: NONE" or
// "TOYS: 0". Shared by hasFindings, scoreResponse, and items.ts's extractItems so a
// junk line is never accidentally persisted as a real finding line by one consumer
// while being correctly ignored by another.
export function isJunkLine(line: string): boolean {
  const t = line.trim().toUpperCase();
  return t.endsWith(": 0") || t.endsWith(": NONE") || t.endsWith(": NONE VISIBLE");
}

export function hasFindings(response: string): boolean {
  const trimmed = response.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toUpperCase();
  if (normalized === "NOTHING") return false;

  // 1400 chars allows ~15 items at ~90 chars each (description + confidence tag).
  if (trimmed.length > 1400) return false;
  if (/^(The image|I can|This image|In this image|The photo)/i.test(trimmed)) return false;

  const lines = normalized.split(/\r?\n/).filter((line) => line.trim());
  const junk = lines.filter(isJunkLine).length;

  return junk < lines.length;
}

function extractLineConfidence(line: string): Confidence | null {
  const match = /\[(high|medium|low)\]\s*$/i.exec(line.trim());
  if (!match) return null;
  return match[1]!.toLowerCase() as Confidence;
}

function extractTopConfidence(response: string): Confidence | null {
  const order: Confidence[] = ["high", "medium", "low"];
  let best: Confidence | null = null;
  for (const line of response.split(/\r?\n/)) {
    const c = extractLineConfidence(line);
    if (c !== null) {
      const idx = order.indexOf(c);
      if (best === null || idx < order.indexOf(best)) best = c;
    }
  }
  return best;
}

function stripConfidenceTags(response: string): string {
  return response
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*\[(high|medium|low)\]\s*$/i, "").trimEnd())
    .join("\n")
    .trim();
}

function scoreResponse(response: string): number {
  if (!hasFindings(response)) return 0;
  const lines = response.trim().split(/\r?\n/).filter((l) => l.trim() && !isJunkLine(l));
  return lines.reduce((sum, line) => {
    const c = extractLineConfidence(line);
    return sum + (c === "high" ? 1.0 : c === "medium" ? 0.5 : c === "low" ? 0.15 : 0.5);
  }, 0);
}

// Emit one analyzed_image event per processed Image so the scan persists the full
// corpus row (phash + position), not just the flagged findings. Errored images are
// still real Images in the listing, so they're persisted too. `totalOriginal` is the
// full listing size (sale.imageUrls.length), not the post-dedup/skip candidate
// count, so positionPct means "where in the listing" even on an incremental re-scan
// that only sees newly-appended Images.
function* emitAnalyzed(
  saleId: string,
  tagged: TaggedResult[],
  totalOriginal: number,
  phashByUrl: Map<string, string | null>,
): Generator<VisionEvent> {
  for (const r of tagged) {
    yield {
      type: "analyzed_image",
      saleId,
      imageUrl: r.url,
      phash: phashByUrl.get(r.url) ?? null,
      positionPct: r.positionIndex / Math.max(totalOriginal - 1, 1),
      thumbnailPath: r.thumbnailPath,
      visionResponse: r.response || null,
    };
  }
}

// Persist pHash-dropped near-duplicates as null-response image rows so the next
// incremental scan's skip-set (getProcessedImageUrls) includes them. Without this, a
// dropped dupe's URL never enters the images table; the next run finds it "unseen"
// again but its surviving twin is no longer in that run's candidate batch, so the
// dupe passes dedup and gets a second (paid) vision pass, inflating the sale's score.
function* emitDuplicates(
  saleId: string,
  duplicateUrls: string[],
  originalIndexByUrl: Map<string, number>,
  totalOriginal: number,
  phashByUrl: Map<string, string | null>,
): Generator<VisionEvent> {
  for (const url of duplicateUrls) {
    yield {
      type: "analyzed_image",
      saleId,
      imageUrl: url,
      phash: phashByUrl.get(url) ?? null,
      positionPct: (originalIndexByUrl.get(url) ?? 0) / Math.max(totalOriginal - 1, 1),
      thumbnailPath: null,
      visionResponse: null,
    };
  }
}

// Run processImage over a batch and fold the results into the shared accumulators.
// Extracted because the same "mapPool over an image slice, tally score/errors, push
// into allTagged" shape was duplicated across the full-pass, tail-probe, and
// intermediate-zone branches below. positionIndex comes from the image's absolute
// slot in the original listing (originalIndexByUrl), not loop-local offsets — a
// findIndex against uniqueImages would break for an Image already dropped from this
// run's candidate set.
async function processImagesInto(
  images: Array<{ url: string; buffer: Buffer }>,
  saleId: string,
  workers: number,
  originalIndexByUrl: Map<string, number>,
  fallbackIndex: number,
  allTagged: TaggedResult[],
): Promise<{ scoreDelta: number; errorDelta: number }> {
  if (images.length === 0) return { scoreDelta: 0, errorDelta: 0 };
  const results = await mapPool(images, workers, (img) => processImage(img.url, saleId, img.buffer));
  let scoreDelta = 0;
  let errorDelta = 0;
  for (const r of results) {
    if (r.error) errorDelta++;
    else scoreDelta += scoreResponse(r.response);
    const positionIndex = originalIndexByUrl.get(r.url) ?? fallbackIndex;
    allTagged.push({ ...r, positionIndex });
  }
  return { scoreDelta, errorDelta };
}

// sale_skip + the corpus flush + sale_done — the epilogue shared by both early-stop
// branches (small sale fully covered by lead; lead+tail both came up empty).
function* emitEarlyStop(
  sale: ScrapedSale,
  imagesAnalyzed: number,
  totalImages: number,
  errors: number,
  saleScore: number,
  allTagged: TaggedResult[],
  totalOriginal: number,
  phashByUrl: Map<string, string | null>,
): Generator<VisionEvent> {
  yield {
    type: "sale_skip",
    saleId: sale.saleId,
    title: sale.title,
    url: sale.url,
    imagesAnalyzed,
    totalImages,
  };
  yield* emitAnalyzed(sale.saleId, allTagged, totalOriginal, phashByUrl);
  yield {
    type: "sale_done",
    saleId: sale.saleId,
    title: sale.title,
    url: sale.url,
    imagesProcessed: imagesAnalyzed,
    imagesWithFindings: 0,
    errors,
    analysisPhase: "EARLY_STOP",
    totalImages,
    saleScore,
  };
}

function sampleK<T>(arr: T[], k: number): T[] {
  if (arr.length <= k) return [...arr];
  const copy = [...arr];
  const result: T[] = [];
  while (result.length < k) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]!);
  }
  return result;
}

// ─── Stage 1: Perceptual hash deduplication ───────────────────────────────────

function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let n = 0;
  while (xor) {
    n += Number(xor & 1n);
    xor >>= 1n;
  }
  return n;
}

async function computeDHash(buffer: Buffer): Promise<bigint> {
  // dHash: resize to 9×8 grayscale, compare adjacent columns per row → 64-bit fingerprint
  const { data } = await sharp(buffer)
    .resize(9, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col]!;
      const right = data[row * 9 + col + 1]!;
      hash = (hash << 1n) | (left < right ? 1n : 0n);
    }
  }
  return hash;
}

// ─── Stage 1b: Image quality gate (blur + darkness, no model needed) ─────────

async function passesQualityGate(buffer: Buffer): Promise<boolean> {
  try {
    const { data } = await sharp(buffer)
      .resize(256, 256, { fit: "inside" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = data.length;

    // Darkness: mean brightness below threshold → unusable
    let sum = 0;
    for (let i = 0; i < pixels; i++) sum += data[i]!;
    const mean = sum / pixels;
    if (mean < 20) return false;

    // Blur: variance of pixel values — blurry images have low variance
    let variance = 0;
    for (let i = 0; i < pixels; i++) variance += (data[i]! - mean) ** 2;
    variance /= pixels;
    if (variance < 100) return false;

    return true;
  } catch {
    return true; // fail open
  }
}

// ─── Stage 2: Local gate (RunPod mode only) ───────────────────────────────────

async function runLocalGate(imageBase64: string): Promise<boolean> {
  // System message carries criteria (keeps text tokens out of the user turn so the
  // model's attention budget stays on the image). User turn is image + minimal question.
  // keep_alive keeps 30B model hot in VRAM across the full 6-hour batch window.
  // num_predict:10 prevents over-generation; /no_think suppresses Qwen3 CoT preamble.
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: LOCAL_GATE_SYSTEM },
          { role: "user", content: LOCAL_GATE_PROMPT, images: [imageBase64] },
        ],
        stream: false,
        keep_alive: "2h",
        options: { temperature: 0, num_predict: 10 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return true; // fail open
    const payload = (await response.json()) as { message?: { content?: string } };
    const raw = (payload.message?.content ?? "").trim();
    // Strip Qwen3 <think>...</think> blocks if /no_think didn't suppress them
    const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    // Use the LAST non-empty word — model sometimes prefixes a brief note
    const words = stripped.split(/\s+/).filter(Boolean);
    const decision = (words[words.length - 1] ?? "").toUpperCase();
    return decision !== "SKIP";
  } catch {
    return true; // fail open
  }
}

// ─── Stage 3: Full vision analysis ───────────────────────────────────────────

async function runVisionOllama(imageBase64: string): Promise<string> {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        { role: "user", content: VISION_USER_PROMPT, images: [imageBase64] },
      ],
      stream: false,
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);

  const payload = (await response.json()) as { message?: { content?: string } };
  return (payload.message?.content ?? "")
    .split("\n")
    .filter((line) => line.trim().toUpperCase() !== "NOTHING")
    .join("\n")
    .trim();
}

// OpenAI-compatible managed API (Gemini, OpenRouter, RunPod vLLM, etc.)
// Gemini: VISION_API_BASE=https://generativelanguage.googleapis.com/v1beta/openai
async function runVisionManaged(imageBase64: string): Promise<string> {
  const response = await fetch(`${VISION_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VISION_API_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_API_MODEL,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            { type: "text", text: VISION_USER_PROMPT },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) throw new Error(`Vision API HTTP ${response.status}`);

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (payload.choices?.[0]?.message?.content ?? "")
    .split("\n")
    .filter((line) => line.trim().toUpperCase() !== "NOTHING")
    .join("\n")
    .trim();
}

function runVision(imageBase64: string): Promise<string> {
  return VISION_API_BASE ? runVisionManaged(imageBase64) : runVisionOllama(imageBase64);
}

// ─── Per-image processing (quality gate → local gate → full vision) ───────────

async function processImage(
  url: string,
  saleId: string,
  preloadedBuffer?: Buffer,
): Promise<ImageResult> {
  const started = performance.now();
  const result: ImageResult = {
    url,
    saleId,
    response: "",
    error: "",
    durationS: 0,
    thumbnailPath: null,
  };

  try {
    const buffer = preloadedBuffer ?? (await fetchBuffer(url));
    if (!buffer) throw new Error("image download failed");

    // Durable thumbnail for every analyzed Image (ADR 0013) — written before the
    // quality gate so even gated-out junk is preserved as a negative exemplar and
    // stays re-embeddable. Fail-open: null path just means the row gets no thumbnail.
    result.thumbnailPath = await writeThumbnail(saleId, url, buffer);

    if (!(await passesQualityGate(buffer))) {
      // Quality gate filtered — return empty response (not an error)
      result.durationS = Math.round((performance.now() - started) / 10) / 100;
      return result;
    }

    const resized = await sharp(buffer)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const base64 = resized.toString("base64");

    // Free GPU pre-filter (own hardware). Screens out obvious non-candidates before
    // the paid vision backend sees them — cuts the "paid for a NOTHING result" rate.
    // Fails open (LOCAL_GATE_ENABLED=false bypasses it entirely, e.g. no local Ollama).
    if (LOCAL_GATE_ENABLED && !(await runLocalGate(base64))) {
      result.durationS = Math.round((performance.now() - started) / 10) / 100;
      return result;
    }

    result.response = await runVision(base64);
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 120) : "unknown error";
  }

  result.durationS = Math.round((performance.now() - started) / 10) / 100;
  return result;
}

// ─── Pool concurrency helper ──────────────────────────────────────────────────

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );

  return results;
}

export async function checkModelAvailable(
  model = OLLAMA_MODEL,
  host = OLLAMA_HOST,
): Promise<boolean> {
  if (VISION_API_BASE) return true;

  try {
    const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    const payload = (await response.json()) as { models?: Array<{ name: string }> };
    const names = payload.models?.map((entry) => entry.name) ?? [];
    return names.some(
      (name) => name === model || name.startsWith(model.split(":")[0]!),
    );
  } catch {
    return false;
  }
}

// ─── Budget/tier decisions (pure — the money-spending logic, kept testable) ────

export type LeadOutcome = "FULL" | "TAIL_PROBE_CANDIDATE" | "INTERMEDIATE";

// After the lead sample scores a sale, decide whether to process the rest in full,
// probe the tail before committing, or continue as an intermediate-confidence sale
// (which still gets a full pass but is oracle-eligible). Pulled out as a pure
// function so the threshold boundaries are unit-testable without running the vision
// pipeline — this decision controls how much of the paid VLM budget a sale spends.
export function decideLeadOutcome(
  saleScore: number,
  leadCount: number,
  total: number,
): LeadOutcome {
  if (leadCount >= total || saleScore >= HIGH_SCORE_THRESHOLD) return "FULL";
  if (saleScore < SWITCH_SCORE_THRESHOLD) return "TAIL_PROBE_CANDIDATE";
  return "INTERMEDIATE";
}

// Whether an intermediate/uncertain-zone sale should be escalated to the (paid)
// oracle. Requires the oracle to be configured, at least one finding, and a score
// inside the uncertain band — clearly wrong-but-cheap (below MIN) or clearly right
// (at/above MAX) sales don't need the expensive tiebreaker.
export function shouldEscalateToOracle(
  oracleConfigured: boolean,
  foundCount: number,
  saleScore: number,
): boolean {
  return (
    oracleConfigured &&
    foundCount > 0 &&
    saleScore >= ORACLE_SCORE_MIN &&
    saleScore < ORACLE_SCORE_MAX
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

const MAX_PER_DESCRIPTION = 5;

export async function* processSalesStream(
  sales: ScrapedSale[],
  options: {
    maxImages?: number;
    skipUrls?: Set<string>;
    workers?: number;
    dryRun?: boolean;
    referenceMode?: boolean;
  } = {},
): AsyncGenerator<VisionEvent> {
  const skipUrls = options.skipUrls ?? new Set<string>();
  const workers = options.workers ?? VISION_WORKERS;
  const dryRun = options.dryRun ?? false;
  const referenceMode = options.referenceMode ?? false;
  const totalSales = sales.length;

  for (const [saleIdx, sale] of sales.entries()) {
    // Absolute position in the full listing, independent of what this run's
    // skip-set/maxImages filtering removes — used for positionPct so it stays
    // meaningful across incremental multi-night scans (an Image appended to a
    // 50-Image listing gets position ~50/50, not 0/10).
    const originalIndexByUrl = new Map(sale.imageUrls.map((url, i) => [url, i]));
    const totalOriginal = sale.imageUrls.length;

    let candidateUrls = sale.imageUrls.filter((url) => !skipUrls.has(url));
    if (options.maxImages) candidateUrls = candidateUrls.slice(0, options.maxImages);
    if (candidateUrls.length === 0) continue;

    const originalCandidateTotal = candidateUrls.length;

    // ── Stage 1: Download all candidates + pHash dedup ─────────────────────
    // All images downloaded upfront so pHash can compare across the full set;
    // adaptive sampling phases reuse the cached buffers without re-downloading.
    const seenHashes: bigint[] = [];
    const phashByUrl = new Map<string, string | null>();
    const duplicateUrls: string[] = [];
    const deduped = await mapPool(candidateUrls, PREFILTER_WORKERS, async (url) => {
      const buffer = await fetchBuffer(url);
      if (!buffer) return null;
      try {
        const hash = await computeDHash(buffer);
        if (seenHashes.some((h) => hammingDistance(hash, h) <= PHASH_HAMMING_THRESHOLD)) {
          // Record the drop (not just discard it) so it's persisted below and enters
          // the skip-set on the next incremental scan — otherwise this URL looks
          // "unseen" next time, but its surviving twin may no longer be in that run's
          // candidate batch, so the dupe passes dedup and gets a second paid pass.
          phashByUrl.set(url, hash.toString(16).padStart(16, "0"));
          duplicateUrls.push(url);
          return null;
        }
        seenHashes.push(hash);
        phashByUrl.set(url, hash.toString(16).padStart(16, "0"));
      } catch {
        // pHash failed — keep the image, leave phash null
        phashByUrl.set(url, null);
      }
      return { url, buffer };
    });

    const uniqueImages = deduped.filter(
      (x): x is { url: string; buffer: Buffer } => x !== null,
    );
    const total = uniqueImages.length;

    const dupesRemoved = originalCandidateTotal - total;
    console.log(
      `  [dedup]     ${originalCandidateTotal} → ${total} unique` +
        (dupesRemoved > 0 ? ` (${dupesRemoved} near-dupes removed)` : ""),
    );

    if (total === 0) continue;

    yield {
      type: "sale_start",
      saleIdx,
      totalSales,
      saleId: sale.saleId,
      title: sale.title,
      url: sale.url,
      total,
      originalTotal: originalCandidateTotal,
    };

    if (dryRun) {
      console.log(`  [dry-run]   would analyze ${total} images`);
      yield {
        type: "sale_done",
        saleId: sale.saleId,
        title: sale.title,
        url: sale.url,
        imagesProcessed: 0,
        imagesWithFindings: 0,
        errors: 0,
        analysisPhase: "FULL",
        totalImages: total,
        saleScore: 0,
      };
      continue;
    }

    // Persist dropped near-duplicates so they enter the skip-set — see the comment
    // at the push site above. Skipped for dry-run (no persistence should happen);
    // harmless no-op for reference mode (its sale_done branch never flushes
    // analyzed_image events to the DB).
    yield* emitDuplicates(sale.saleId, duplicateUrls, originalIndexByUrl, totalOriginal, phashByUrl);

    // ── Reference mode: full pass, no sampling, emit every image ──────────
    // Money-no-object ground truth for recall@K (ADR 0010). Tier 0 (dedup +
    // quality gate) still applies so the reference universe matches what the
    // cheap cascade will later rank; sampling/local-gate/oracle are bypassed.
    if (referenceMode) {
      const refResults = await mapPool(uniqueImages, workers, (img) =>
        processImage(img.url, sale.saleId, img.buffer),
      );
      let refFound = 0;
      let refErrors = 0;
      for (const [i, r] of refResults.entries()) {
        if (r.error) refErrors++;
        const has = !r.error && hasFindings(r.response);
        if (has) refFound++;
        yield {
          type: "image_result",
          saleId: sale.saleId,
          imageUrl: r.url,
          response: r.response,
          error: r.error,
          positionIndex: i,
          total,
          hasFindings: has,
        };
      }
      yield {
        type: "sale_done",
        saleId: sale.saleId,
        title: sale.title,
        url: sale.url,
        imagesProcessed: refResults.length,
        imagesWithFindings: refFound,
        errors: refErrors,
        analysisPhase: "FULL",
        totalImages: total,
        saleScore: 0,
      };
      continue;
    }

    // ── Stage 2: Adaptive sampling on the deduped set ─────────────────────
    // Lead sample → score → decide: full pass, tail probe, or early stop.
    // Quality gate + local gate run inside processImage per analyzed image.
    const leadCount = Math.max(1, Math.ceil(total * LEAD_SAMPLE_PCT));
    const leadImages = uniqueImages.slice(0, leadCount);

    let saleScore = 0;
    let errors = 0;
    const allTagged: TaggedResult[] = [];

    {
      const { scoreDelta, errorDelta } = await processImagesInto(
        leadImages,
        sale.saleId,
        workers,
        originalIndexByUrl,
        0,
        allTagged,
      );
      saleScore += scoreDelta;
      errors += errorDelta;
    }

    let analysisPhase: AnalysisPhase = "FULL";

    const leadOutcome = decideLeadOutcome(saleScore, leadCount, total);

    if (leadOutcome === "FULL") {
      // Strong signal or lead already covered everything — process remaining
      const remainImages = uniqueImages.slice(leadCount);
      const { scoreDelta, errorDelta } = await processImagesInto(
        remainImages,
        sale.saleId,
        workers,
        originalIndexByUrl,
        leadCount,
        allTagged,
      );
      saleScore += scoreDelta;
      errors += errorDelta;
      analysisPhase = "FULL";
    } else if (leadOutcome === "TAIL_PROBE_CANDIDATE") {
      // Weak lead — probe the tail before committing to full analysis
      const tailStart = Math.max(Math.floor(total * TAIL_SAMPLE_PCT_START), leadCount);
      const tailPool = uniqueImages.slice(tailStart);

      if (tailPool.length === 0) {
        // Small sale; lead covered everything meaningful
        const imagesAnalyzed = leadCount;
        yield* emitEarlyStop(
          sale,
          imagesAnalyzed,
          total,
          errors,
          saleScore,
          allTagged,
          totalOriginal,
          phashByUrl,
        );
        continue;
      }

      const tailSample = sampleK(tailPool, TAIL_SAMPLE_K);
      const tailTagged: TaggedResult[] = [];
      const { scoreDelta: tailScore, errorDelta: tailErrors } = await processImagesInto(
        tailSample,
        sale.saleId,
        workers,
        originalIndexByUrl,
        tailStart,
        tailTagged,
      );
      errors += tailErrors;

      if (tailScore === 0) {
        // Nothing in lead AND tail — skip this sale
        const imagesAnalyzed = leadCount + tailTagged.length;
        allTagged.push(...tailTagged); // capture tail-probe Images for the corpus
        yield* emitEarlyStop(
          sale,
          imagesAnalyzed,
          total,
          errors,
          saleScore,
          allTagged,
          totalOriginal,
          phashByUrl,
        );
        continue;
      }

      // Tail found something — fill in the middle and any un-sampled tail images
      analysisPhase = "TAIL_PROBE";
      const probedUrls = new Set(tailSample.map((img) => img.url));
      const unprobed = uniqueImages
        .slice(leadCount)
        .filter((img) => !probedUrls.has(img.url));

      allTagged.push(...tailTagged);
      saleScore += tailScore;

      const { scoreDelta, errorDelta } = await processImagesInto(
        unprobed,
        sale.saleId,
        workers,
        originalIndexByUrl,
        leadCount,
        allTagged,
      );
      saleScore += scoreDelta;
      errors += errorDelta;
    } else {
      // Intermediate zone — full analysis, oracle escalates if uncertain
      const remainImages = uniqueImages.slice(leadCount);
      const { scoreDelta, errorDelta } = await processImagesInto(
        remainImages,
        sale.saleId,
        workers,
        originalIndexByUrl,
        leadCount,
        allTagged,
      );
      saleScore += scoreDelta;
      errors += errorDelta;
      analysisPhase = "FULL";
    }

    allTagged.sort((a, b) => a.positionIndex - b.positionIndex);

    // ── Stage 3: Emit findings ──────────────────────────────────────────────
    let found = 0;
    const descCounts = new Map<string, number>();

    for (const [idx, result] of allTagged.entries()) {
      if (!result.error && hasFindings(result.response)) {
        const key = result.response.trim().toLowerCase();
        const count = (descCounts.get(key) ?? 0) + 1;
        descCounts.set(key, count);

        if (count <= MAX_PER_DESCRIPTION) {
          found++;
          const confidence = extractTopConfidence(result.response);
          const description = stripConfidenceTags(result.response);
          const imagePositionPct = result.positionIndex / Math.max(totalOriginal - 1, 1);

          yield {
            type: "finding",
            saleId: sale.saleId,
            imageUrl: result.url,
            description,
            confidence,
            imagePositionPct,
            durationS: result.durationS,
          };
        }
      }

      yield {
        type: "progress",
        saleId: sale.saleId,
        done: idx + 1,
        total: allTagged.length,
        found,
        errors,
      };
    }

    // ── Oracle escalation for uncertain-zone sales ─────────────────────────
    if (shouldEscalateToOracle(Boolean(ORACLE_API_BASE), found, saleScore)) {
      // Judge the sale on its strongest findings, not the first 6 in listing order —
      // allTagged is sorted by position above, so without this the oracle could see
      // only the sale's weakest images.
      const topImageUrls = allTagged
        .filter((r) => !r.error && hasFindings(r.response))
        .sort((a, b) => scoreResponse(b.response) - scoreResponse(a.response))
        .slice(0, 6)
        .map((r) => r.url);

      yield {
        type: "oracle_request",
        saleId: sale.saleId,
        title: sale.title,
        address: `${sale.address}, ${sale.city}, ${sale.state}`,
        imageUrls: topImageUrls,
        saleScore,
      };
    }

    yield* emitAnalyzed(sale.saleId, allTagged, totalOriginal, phashByUrl);
    yield {
      type: "sale_done",
      saleId: sale.saleId,
      title: sale.title,
      url: sale.url,
      imagesProcessed: allTagged.length,
      imagesWithFindings: found,
      errors,
      analysisPhase,
      totalImages: total,
      saleScore,
    };
  }

  yield { type: "done" };
}
