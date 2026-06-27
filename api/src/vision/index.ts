import sharp from "sharp";
import {
  OLLAMA_HOST,
  OLLAMA_MODEL,
  PHASH_HAMMING_THRESHOLD,
  LOCAL_GATE_PROMPT,
  PREFILTER_WORKERS,
  RUNPOD_API_KEY,
  RUNPOD_ENDPOINT_ID,
  RUNPOD_MODEL,
  VISION_SYSTEM_PROMPT,
  VISION_USER_PROMPT,
  VISION_WORKERS,
} from "../lib/constants.js";
import { fetchBuffer } from "../lib/http.js";
import type { ScrapedSale } from "../scraper/index.js";

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
      durationS: number;
    }
  | {
      type: "sale_done";
      saleId: string;
      title: string;
      url: string;
      imagesProcessed: number;
      imagesWithFindings: number;
      errors: number;
    }
  | { type: "done" };

type ImageResult = {
  url: string;
  saleId: string;
  response: string;
  error: string;
  durationS: number;
};

export function hasFindings(response: string): boolean {
  const trimmed = response.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toUpperCase();
  if (normalized === "NOTHING") return false;

  if (trimmed.length > 1000) return false;
  if (/^(The image|I can|This image|In this image|The photo)/i.test(trimmed)) return false;

  const lines = normalized.split(/\r?\n/).filter((line) => line.trim());
  const junk = lines.filter(
    (line) =>
      line.endsWith(": 0") ||
      line.endsWith(": NONE") ||
      line.endsWith(": NONE VISIBLE"),
  ).length;

  return junk < lines.length;
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

// ─── Stage 2: Ollama pre-filter ───────────────────────────────────────────────

async function runLocalGate(imageBase64: string): Promise<boolean> {
  // Runs local Ollama with a permissive prompt. Any non-NOTHING response passes
  // the image through to RunPod. This gates on "is there anything here at all"
  // rather than quality — RunPod handles quality on the hits.
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: "user", content: LOCAL_GATE_PROMPT, images: [imageBase64] }],
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return true; // fail open
    const payload = (await response.json()) as { message?: { content?: string } };
    const text = (payload.message?.content ?? "").trim();
    // Pass through unless model is confident there is nothing
    return text.toUpperCase() !== "NOTHING" && text.length > 0;
  } catch {
    return true; // fail open
  }
}

// ─── Stage 3: Full vision analysis ────────────────────────────────────────────

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

async function runVisionRunpod(imageBase64: string): Promise<string> {
  const url = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/openai/v1/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RUNPOD_API_KEY}`,
    },
    body: JSON.stringify({
      model: RUNPOD_MODEL,
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

  if (!response.ok) throw new Error(`RunPod HTTP ${response.status}`);

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (payload.choices?.[0]?.message?.content ?? "")
    .split("\n")
    .filter((line) => line.trim().toUpperCase() !== "NOTHING")
    .join("\n")
    .trim();
}

async function runVision(imageBase64: string): Promise<string> {
  return RUNPOD_ENDPOINT_ID ? runVisionRunpod(imageBase64) : runVisionOllama(imageBase64);
}

async function processImage(
  url: string,
  saleId: string,
  preloadedBuffer?: Buffer,
): Promise<ImageResult> {
  const started = performance.now();
  const result: ImageResult = { url, saleId, response: "", error: "", durationS: 0 };

  try {
    const buffer = preloadedBuffer ?? (await fetchBuffer(url));
    if (!buffer) throw new Error("image download failed");

    const resized = await sharp(buffer)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    result.response = await runVision(resized.toString("base64"));
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 120) : "unknown error";
  }

  result.durationS = Math.round((performance.now() - started) / 10) / 100;
  return result;
}

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
  if (RUNPOD_ENDPOINT_ID) return true;

  try {
    const response = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;

    const payload = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    const names = payload.models?.map((entry) => entry.name) ?? [];
    return names.some(
      (name) => name === model || name.startsWith(model.split(":")[0]!),
    );
  } catch {
    return false;
  }
}

const MAX_PER_DESCRIPTION = 5;

export async function* processSalesStream(
  sales: ScrapedSale[],
  options: {
    maxImages?: number;
    skipUrls?: Set<string>;
    workers?: number;
    dryRun?: boolean;
  } = {},
): AsyncGenerator<VisionEvent> {
  const skipUrls = options.skipUrls ?? new Set<string>();
  const workers = options.workers ?? VISION_WORKERS;
  const dryRun = options.dryRun ?? false;
  const totalSales = sales.length;

  for (const [saleIdx, sale] of sales.entries()) {
    let candidateUrls = sale.imageUrls.filter((url) => !skipUrls.has(url));
    if (options.maxImages) {
      candidateUrls = candidateUrls.slice(0, options.maxImages);
    }
    if (candidateUrls.length === 0) continue;

    // ── Phase 1: Download + pHash deduplication ──────────────────────────────
    const seenHashes: bigint[] = [];
    const deduped = await mapPool(candidateUrls, 8, async (url) => {
      const buffer = await fetchBuffer(url);
      if (!buffer) return null;
      try {
        const hash = await computeDHash(buffer);
        if (seenHashes.some((h) => hammingDistance(hash, h) <= PHASH_HAMMING_THRESHOLD)) {
          return null;
        }
        seenHashes.push(hash);
      } catch {
        // pHash failed — keep the image
      }
      return { url, buffer };
    });
    const uniqueImages = deduped.filter(
      (x): x is { url: string; buffer: Buffer } => x !== null,
    );

    const dupesRemoved = candidateUrls.length - uniqueImages.length;
    console.log(`  [dedup]     ${candidateUrls.length} → ${uniqueImages.length} unique${dupesRemoved > 0 ? ` (${dupesRemoved} near-dupes removed)` : " (no dupes found)"}`);

    // ── Phase 2: Ollama pre-filter (RunPod mode only) ────────────────────────
    let filteredImages = uniqueImages;
    if (RUNPOD_ENDPOINT_ID && uniqueImages.length > 0) {
      const prefilterResults = await mapPool(
        uniqueImages,
        PREFILTER_WORKERS,
        async (img) => {
          // Use 1024px so local model sees enough detail to detect items
          const sized = await sharp(img.buffer)
            .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          const pass = await runLocalGate(sized.toString("base64"));
          return pass ? img : null;
        },
      );
      filteredImages = prefilterResults.filter(
        (x): x is { url: string; buffer: Buffer } => x !== null,
      );
      const prefilterRemoved = uniqueImages.length - filteredImages.length;
      console.log(`  [local gate] ${uniqueImages.length} → ${filteredImages.length} passed to RunPod${prefilterRemoved > 0 ? ` (${prefilterRemoved} rejected as irrelevant)` : " (all passed)"}`);
    }

    const total = filteredImages.length;
    const originalTotal = candidateUrls.length;

    if (total === 0) continue;

    yield {
      type: "sale_start",
      saleIdx,
      totalSales,
      saleId: sale.saleId,
      title: sale.title,
      url: sale.url,
      total,
      originalTotal,
    };

    // ── Phase 3: Full vision analysis ─────────────────────────────────────────
    if (dryRun) {
      console.log(`  [dry-run]   would send ${total} images to vision model`);
      yield { type: "sale_done", saleId: sale.saleId, title: sale.title, url: sale.url, imagesProcessed: 0, imagesWithFindings: 0, errors: 0 };
      continue;
    }

    let errors = 0;
    const results = await mapPool(filteredImages, workers, (img) =>
      processImage(img.url, sale.saleId, img.buffer),
    );

    let found = 0;
    const descriptionCounts = new Map<string, number>();

    for (const [index, result] of results.entries()) {
      if (result.error) {
        errors += 1;
      } else if (hasFindings(result.response)) {
        const key = result.response.trim().toLowerCase();
        const count = (descriptionCounts.get(key) ?? 0) + 1;
        descriptionCounts.set(key, count);

        if (count <= MAX_PER_DESCRIPTION) {
          found += 1;
          yield {
            type: "finding",
            saleId: sale.saleId,
            imageUrl: result.url,
            description: result.response,
            durationS: result.durationS,
          };
        }
      }

      yield {
        type: "progress",
        saleId: sale.saleId,
        done: index + 1,
        total,
        found,
        errors,
      };
    }

    yield {
      type: "sale_done",
      saleId: sale.saleId,
      title: sale.title,
      url: sale.url,
      imagesProcessed: total,
      imagesWithFindings: found,
      errors,
    };
  }

  yield { type: "done" };
}
