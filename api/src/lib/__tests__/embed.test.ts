import { describe, expect, it } from "vitest";
import { blobToFloat32, float32ToBlob, parseEmbedResponse } from "../embed.js";

describe("float32 blob round-trip", () => {
  it("preserves values through encode/decode", () => {
    const vec = [0, 1, -1, 0.5, -0.25, 3.14159, 1e-6, 1e6];
    const out = blobToFloat32(float32ToBlob(vec));
    expect(out).toHaveLength(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(out[i]).toBeCloseTo(vec[i]!, 3);
    }
  });

  it("encodes 4 bytes per element", () => {
    expect(float32ToBlob([1, 2, 3]).length).toBe(12);
  });
});

describe("parseEmbedResponse", () => {
  it("returns vectors ordered by index", () => {
    const payload = {
      data: [
        { index: 1, embedding: [4, 5, 6] },
        { index: 0, embedding: [1, 2, 3] },
      ],
    };
    expect(parseEmbedResponse(payload, 2)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("fills missing entries with null", () => {
    const payload = { data: [{ index: 0, embedding: [1, 2, 3] }] };
    expect(parseEmbedResponse(payload, 3)).toEqual([[1, 2, 3], null, null]);
  });

  it("handles an empty / malformed payload", () => {
    expect(parseEmbedResponse({}, 2)).toEqual([null, null]);
  });

  it("falls back to array position when index is absent", () => {
    const payload = { data: [{ embedding: [1] }, { embedding: [2] }] };
    expect(parseEmbedResponse(payload, 2)).toEqual([[1], [2]]);
  });

  describe("frozen-model dimension guard (ADR 0016)", () => {
    it("rejects a vector of the wrong dimension", () => {
      const payload = {
        data: [
          { index: 0, embedding: [1, 2, 3] }, // wrong dim
          { index: 1, embedding: [1, 2, 3, 4] }, // matches
        ],
      };
      expect(parseEmbedResponse(payload, 2, 4)).toEqual([null, [1, 2, 3, 4]]);
    });

    it("accepts any dimension when no guard is set", () => {
      const payload = { data: [{ index: 0, embedding: [1, 2, 3] }] };
      expect(parseEmbedResponse(payload, 1, null)).toEqual([[1, 2, 3]]);
    });
  });
});
