import { describe, expect, it } from "vitest";
import { toReferenceRecord } from "../reference.js";
import type { VisionEvent } from "../../vision/index.js";

// toReferenceRecord is the pure mapping scan/index.ts's main() loop uses to turn
// each reference-mode `image_result` VisionEvent into the flat ReferenceRecord row
// it accumulates and (via --reference <path>) writes to disk — the frozen
// ground-truth dump ADR 0010's recall@K, and now api/eval/calibrate-runpod.ts's
// backend-agreement/latency stats, are measured against. Pulled into its own
// module specifically so this mapping is unit-testable without importing
// scan/index.ts, which self-executes a real scan on import.
function imageResultEvent(
  overrides: Partial<Extract<VisionEvent, { type: "image_result" }>> = {},
): Extract<VisionEvent, { type: "image_result" }> {
  return {
    type: "image_result",
    saleId: "GA-1",
    imageUrl: "https://cdn.test/a.jpg",
    response: "Stickley oak armchair [high]",
    error: "",
    positionIndex: 3,
    total: 10,
    hasFindings: true,
    durationS: 4.21,
    backend: "Qwen/Qwen3-VL-32B-Instruct",
    ...overrides,
  };
}

describe("toReferenceRecord", () => {
  it("copies durationS and backend straight from the event", () => {
    const record = toReferenceRecord(imageResultEvent(), "Some Sale", "https://example.com/sale/GA-1");
    expect(record.durationS).toBe(4.21);
    expect(record.backend).toBe("Qwen/Qwen3-VL-32B-Instruct");
  });

  it("distinguishes durationS/backend across two differently-timed/backed events (not a shared default)", () => {
    const a = toReferenceRecord(
      imageResultEvent({ durationS: 1.5, backend: "gemini-2.5-flash" }),
      "Sale A",
      "https://example.com/sale/A",
    );
    const b = toReferenceRecord(
      imageResultEvent({ durationS: 9.99, backend: "Qwen/Qwen3-VL-32B-Instruct" }),
      "Sale B",
      "https://example.com/sale/B",
    );
    expect(a.durationS).toBe(1.5);
    expect(a.backend).toBe("gemini-2.5-flash");
    expect(b.durationS).toBe(9.99);
    expect(b.backend).toBe("Qwen/Qwen3-VL-32B-Instruct");
  });

  it("carries every other event field through unchanged and stamps saleTitle/saleUrl from the loop's current-sale state", () => {
    const record = toReferenceRecord(
      imageResultEvent({
        saleId: "GA-99",
        imageUrl: "https://cdn.test/z.jpg",
        response: "NOTHING",
        error: "timeout",
        positionIndex: 7,
        total: 42,
        hasFindings: false,
      }),
      "The Big Sale",
      "https://example.com/sale/GA-99",
    );
    expect(record).toEqual({
      saleId: "GA-99",
      saleTitle: "The Big Sale",
      saleUrl: "https://example.com/sale/GA-99",
      imageUrl: "https://cdn.test/z.jpg",
      positionIndex: 7,
      total: 42,
      response: "NOTHING",
      hasFindings: false,
      error: "timeout",
      durationS: 4.21,
      backend: "Qwen/Qwen3-VL-32B-Instruct",
    });
  });

  it("handles durationS of exactly 0 (fast/cached call) without dropping it as falsy", () => {
    const record = toReferenceRecord(
      imageResultEvent({ durationS: 0 }),
      "Sale",
      "https://example.com/sale/X",
    );
    expect(record.durationS).toBe(0);
  });
});
