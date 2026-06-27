import {
  OLLAMA_HOST,
  OLLAMA_MODEL,
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
  | { type: "done" };

type ImageResult = {
  url: string;
  saleId: string;
  response: string;
  error: string;
  durationS: number;
};

type TaggedResult = ImageResult & { positionIndex: number };

// Determines whether a response string contains real findings.
export function hasFindings(response: string): boolean {
  const trimmed = response.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toUpperCase();
  if (normalized === "NOTHING") return false;

  if (trimmed.length > 1400) return false;
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

// Parse [high]/[medium]/[low] tag from the end of a single item line.
function extractLineConfidence(line: string): Confidence | null {
  const match = /\[(high|medium|low)\]\s*$/i.exec(line.trim());
  if (!match) return null;
  return match[1]!.toLowerCase() as Confidence;
}

// Highest confidence tag across all lines in a response.
export function extractTopConfidence(response: string): Confidence | null {
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

// Remove [high]/[medium]/[low] tags for clean DB storage.
export function stripConfidenceTags(response: string): string {
  return response
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*\[(high|medium|low)\]\s*$/i, "").trimEnd())
    .join("\n")
    .trim();
}

// Weighted score for a single response — used for phase accumulation.
export function scoreResponse(response: string): number {
  if (!hasFindings(response)) return 0;
  const lines = response.trim().split(/\r?\n/).filter((l) => {
    const t = l.trim().toUpperCase();
    return t && !t.endsWith(": 0") && !t.endsWith(": NONE") && !t.endsWith(": NONE VISIBLE");
  });
  return lines.reduce((sum, line) => {
    const c = extractLineConfidence(line);
    return sum + (c === "high" ? 1.0 : c === "medium" ? 0.5 : c === "low" ? 0.15 : 0.5);
  }, 0);
}

// Random sample of k items from arr without replacement.
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
  return (payload.message?.content ?? "")
    .split("\n")
    .filter((line) => line.trim().toUpperCase() !== "NOTHING")
    .join("\n")
    .trim();
}

async function processImage(url: string, saleId: string): Promise<ImageResult> {
  const started = performance.now();
  const result: ImageResult = { url, saleId, response: "", error: "", durationS: 0 };

  try {
    const buffer = await fetchBuffer(url);
    if (!buffer) throw new Error("image download failed");
    result.response = await runVision(buffer.toString("base64"));
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
  try {
    const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    const payload = (await response.json()) as { models?: Array<{ name: string }> };
    const names = payload.models?.map((m) => m.name) ?? [];
    return names.some((n) => n === model || n.startsWith(model.split(":")[0]!));
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
    if (options.maxImages) imageUrls = imageUrls.slice(0, options.maxImages);

    const total = imageUrls.length;
    if (total === 0) continue;

    yield {
      type: "sale_start",
      saleIdx,
      totalSales,
      saleId: sale.saleId,
      title: sale.title,
      url: sale.url,
      total,
    };

    // ── Phase 1: lead sample ──────────────────────────────────────────────
    const leadCount = Math.max(1, Math.ceil(total * LEAD_SAMPLE_PCT));
    const leadUrls = imageUrls.slice(0, leadCount);
    const leadResults = await mapPool(leadUrls, workers, (url) =>
      processImage(url, sale.saleId),
    );

    let saleScore = 0;
    let errors = 0;
    const allTagged: TaggedResult[] = leadResults.map((r, i) => {
      if (r.error) errors++;
      else saleScore += scoreResponse(r.response);
      return { ...r, positionIndex: i };
    });

    let analysisPhase: AnalysisPhase = "FULL";

    // ── Phase routing ─────────────────────────────────────────────────────
    if (leadCount >= total || saleScore >= HIGH_SCORE_THRESHOLD) {
      // Strong signal or already seen everything — process remaining
      if (leadCount < total) {
        const remainUrls = imageUrls.slice(leadCount);
        const remainResults = await mapPool(remainUrls, workers, (url) =>
          processImage(url, sale.saleId),
        );
        for (const [i, r] of remainResults.entries()) {
          if (r.error) errors++;
          else saleScore += scoreResponse(r.response);
          allTagged.push({ ...r, positionIndex: leadCount + i });
        }
      }
      analysisPhase = "FULL";
    } else if (saleScore < SWITCH_SCORE_THRESHOLD) {
      // Weak lead — tail probe
      const tailStart = Math.max(Math.floor(total * TAIL_SAMPLE_PCT_START), leadCount);
      const tailPool = imageUrls.slice(tailStart);

      if (tailPool.length === 0) {
        // Sale is small enough that lead covered everything meaningful — skip
        analysisPhase = "EARLY_STOP";
        const imagesAnalyzed = leadCount;
        yield {
          type: "sale_skip",
          saleId: sale.saleId,
          title: sale.title,
          url: sale.url,
          imagesAnalyzed,
          totalImages: total,
        };
        yield {
          type: "sale_done",
          saleId: sale.saleId,
          title: sale.title,
          url: sale.url,
          imagesProcessed: imagesAnalyzed,
          imagesWithFindings: 0,
          errors,
          analysisPhase,
          totalImages: total,
          saleScore,
        };
        continue;
      }

      const tailSample = sampleK(tailPool, TAIL_SAMPLE_K);
      const tailResults = await mapPool(tailSample, workers, (url) =>
        processImage(url, sale.saleId),
      );

      let tailScore = 0;
      const tailTagged: TaggedResult[] = tailResults.map((r, i) => {
        const posIdx = imageUrls.indexOf(tailSample[i]!);
        if (r.error) errors++;
        else tailScore += scoreResponse(r.response);
        return { ...r, positionIndex: posIdx >= 0 ? posIdx : tailStart + i };
      });

      if (tailScore === 0) {
        // Nothing in lead AND tail — skip this sale
        analysisPhase = "EARLY_STOP";
        const imagesAnalyzed = leadCount + tailResults.length;
        yield {
          type: "sale_skip",
          saleId: sale.saleId,
          title: sale.title,
          url: sale.url,
          imagesAnalyzed,
          totalImages: total,
        };
        yield {
          type: "sale_done",
          saleId: sale.saleId,
          title: sale.title,
          url: sale.url,
          imagesProcessed: imagesAnalyzed,
          imagesWithFindings: 0,
          errors,
          analysisPhase,
          totalImages: total,
          saleScore,
        };
        continue;
      }

      // Tail found something — analyze everything we haven't seen yet
      analysisPhase = "TAIL_PROBE";
      const probedSet = new Set(tailSample);
      const unprobed = imageUrls.slice(leadCount).filter((u) => !probedSet.has(u));

      allTagged.push(...tailTagged);

      if (unprobed.length > 0) {
        const moreResults = await mapPool(unprobed, workers, (url) =>
          processImage(url, sale.saleId),
        );
        for (const [i, r] of moreResults.entries()) {
          const posIdx = imageUrls.indexOf(unprobed[i]!);
          if (r.error) errors++;
          else saleScore += scoreResponse(r.response);
          allTagged.push({ ...r, positionIndex: posIdx >= 0 ? posIdx : leadCount + i });
        }
      }

      saleScore += tailScore;
    } else {
      // Intermediate zone — process everything, oracle will escalate if needed
      if (leadCount < total) {
        const remainUrls = imageUrls.slice(leadCount);
        const remainResults = await mapPool(remainUrls, workers, (url) =>
          processImage(url, sale.saleId),
        );
        for (const [i, r] of remainResults.entries()) {
          if (r.error) errors++;
          else saleScore += scoreResponse(r.response);
          allTagged.push({ ...r, positionIndex: leadCount + i });
        }
      }
      analysisPhase = "FULL";
    }

    // Sort by original image position for consistent ordering
    allTagged.sort((a, b) => a.positionIndex - b.positionIndex);

    // ── Emit findings ─────────────────────────────────────────────────────
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
          const imagePositionPct = result.positionIndex / Math.max(total - 1, 1);

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

    // ── Oracle escalation for uncertain zone ──────────────────────────────
    if (
      ORACLE_API_BASE &&
      found > 0 &&
      saleScore >= ORACLE_SCORE_MIN &&
      saleScore < ORACLE_SCORE_MAX
    ) {
      const topImageUrls = allTagged
        .filter((r) => !r.error && hasFindings(r.response))
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
