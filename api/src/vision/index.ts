import {
  OLLAMA_HOST,
  OLLAMA_MODEL,
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

// Determines whether a response string contains real findings.
// Handles both structured (post-parse) and legacy plain-text responses.
export function hasFindings(response: string): boolean {
  const trimmed = response.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toUpperCase();
  if (normalized === "NOTHING") return false;

  // Reject verbose paragraph responses — valid output is a short list.
  // 1000 chars allows ~10 items with full brand/era/condition attributes (~80 chars each).
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

async function runVision(imageBase64: string): Promise<string> {
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

  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { message?: { content?: string } };
  // Strip spurious trailing "NOTHING" lines qwen occasionally appends to real responses.
  return (payload.message?.content ?? "")
    .split("\n")
    .filter((line) => line.trim().toUpperCase() !== "NOTHING")
    .join("\n")
    .trim();
}

async function processImage(url: string, saleId: string): Promise<ImageResult> {
  const started = performance.now();
  const result: ImageResult = {
    url,
    saleId,
    response: "",
    error: "",
    durationS: 0,
  };

  try {
    const buffer = await fetchBuffer(url);
    if (!buffer) {
      throw new Error("image download failed");
    }

    const imageBase64 = buffer.toString("base64");
    result.response = await runVision(imageBase64);
  } catch (error) {
    result.error =
      error instanceof Error ? error.message.slice(0, 120) : "unknown error";
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
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      runWorker(),
    ),
  );

  return results;
}

export async function checkModelAvailable(
  model = OLLAMA_MODEL,
  host = OLLAMA_HOST,
): Promise<boolean> {
  try {
    const response = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return false;
    }

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
  } = {},
): AsyncGenerator<VisionEvent> {
  const skipUrls = options.skipUrls ?? new Set<string>();
  const workers = options.workers ?? VISION_WORKERS;
  const totalSales = sales.length;

  for (const [saleIdx, sale] of sales.entries()) {
    let imageUrls = sale.imageUrls.filter((url) => !skipUrls.has(url));
    if (options.maxImages) {
      imageUrls = imageUrls.slice(0, options.maxImages);
    }

    const total = imageUrls.length;
    if (total === 0) {
      continue;
    }

    yield {
      type: "sale_start",
      saleIdx,
      totalSales,
      saleId: sale.saleId,
      title: sale.title,
      url: sale.url,
      total,
    };

    let errors = 0;
    const results = await mapPool(imageUrls, workers, (url) =>
      processImage(url, sale.saleId),
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
