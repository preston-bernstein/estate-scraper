import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisionEvent } from "../index.js";
import type { ScrapedSale } from "../../scraper/index.js";

// Reference mode (ADR 0010's frozen ground-truth pass) is where the
// runpod-vision-cutover diff's two new fields actually get produced: the
// `image_result` VisionEvent now carries `durationS` (forwarded from
// processImage's own timing) and `backend` (activeVlmModel() — which backend,
// Gemini or RunPod, actually answered this image) alongside the pre-existing
// fields. api/eval/calibrate-runpod.ts's latency/agreement stats and
// scan/index.ts's ReferenceRecord rows both depend on these being wired
// through correctly, not silently dropped or hardcoded.
//
// Exercises processSalesStream for real (mocking only the network boundary —
// image download + the managed vision API) rather than re-testing runVision's
// HTTP plumbing, which isn't part of this diff.

let dir: string;

function makeNoiseJpeg(): Promise<Buffer> {
  // Random per-pixel noise clears passesQualityGate's brightness (mean>20) and
  // blur (variance>100) thresholds reliably — a flat/solid color would fail
  // the variance check and the image would never reach runVision.
  const width = 32;
  const height = 32;
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 200) + 30;
  return sharp(raw, { raw: { width, height, channels } }).jpeg().toBuffer();
}

function sale(imageUrls: string[]): ScrapedSale {
  return {
    saleId: "GA-REF-1",
    title: "Reference Mode Test Sale",
    url: "https://example.com/sale/GA-REF-1",
    startDate: "2026-07-01",
    endDate: "2026-07-03",
    address: "1 Test St",
    city: "Decatur",
    state: "GA",
    zip: "30033",
    lat: 33.8,
    lon: -84.26,
    distanceMiles: 5,
    imageUrls,
  } as ScrapedSale;
}

describe("processSalesStream — reference mode image_result event", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "es-refmode-"));
    vi.stubEnv("THUMBNAIL_DIR", dir);
    vi.stubEnv("LOCAL_GATE_ENABLED", "false"); // not this diff's concern
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("stamps durationS and backend (the managed VISION_API_MODEL) on the image_result event", async () => {
    vi.stubEnv("VISION_API_BASE", "https://runpod.test/v1");
    vi.stubEnv("VISION_API_KEY", "test-key");
    vi.stubEnv("VISION_API_MODEL", "Qwen/Qwen3-VL-32B-Instruct");
    vi.resetModules();

    const jpeg = await makeNoiseJpeg();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "Stickley oak armchair [high]" } }],
          }),
        } as Response;
      }
      // Image download.
      return {
        ok: true,
        arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
      } as Response;
    });

    const { processSalesStream } = await import("../index.js");

    const events: VisionEvent[] = [];
    for await (const event of processSalesStream([sale(["https://cdn.test/photo1.jpg"])], {
      referenceMode: true,
      workers: 1,
    })) {
      events.push(event);
    }

    const imageResult = events.find((e) => e.type === "image_result");
    expect(imageResult).toBeDefined();
    const e = imageResult as Extract<VisionEvent, { type: "image_result" }>;

    // backend must reflect the ACTIVE managed model, not a hardcoded default —
    // proves activeVlmModel() (not a stale/local constant) is what's stamped.
    expect(e.backend).toBe("Qwen/Qwen3-VL-32B-Instruct");
    expect(e.backend).not.toBe("qwen3-vl:30b"); // OLLAMA_MODEL default — would mean the wrong branch answered

    // durationS must be present and numeric — an ObjectLiteral mutant that
    // drops the field entirely leaves it `undefined` (typeof !== "number").
    expect(typeof e.durationS).toBe("number");
    expect(e.durationS).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(e.durationS)).toBe(false);
  });

  it("stamps the local OLLAMA_MODEL as backend when no managed VISION_API_BASE is configured", async () => {
    vi.stubEnv("VISION_API_BASE", "");
    vi.stubEnv("OLLAMA_MODEL", "qwen3-vl:local-test");
    vi.resetModules();

    const jpeg = await makeNoiseJpeg();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        return {
          ok: true,
          json: async () => ({ message: { content: "grandfather clock [medium]" } }),
        } as Response;
      }
      return {
        ok: true,
        arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
      } as Response;
    });

    const { processSalesStream } = await import("../index.js");

    const events: VisionEvent[] = [];
    for await (const event of processSalesStream([sale(["https://cdn.test/photo2.jpg"])], {
      referenceMode: true,
      workers: 1,
    })) {
      events.push(event);
    }

    const imageResult = events.find((e) => e.type === "image_result") as Extract<
      VisionEvent,
      { type: "image_result" }
    >;
    expect(imageResult).toBeDefined();
    expect(imageResult.backend).toBe("qwen3-vl:local-test");
    expect(typeof imageResult.durationS).toBe("number");
  });
});
