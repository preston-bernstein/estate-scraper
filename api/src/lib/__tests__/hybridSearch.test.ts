import { afterEach, describe, expect, it, vi } from "vitest";
import type { RankedSale } from "../../services/discover.js";
import { bestPerSale, cosine, fuseRRF } from "../hybridSearch.js";

function stubSale(saleId: string, score = 0): RankedSale {
  return {
    saleId,
    title: `Sale ${saleId}`,
    url: `https://example.com/${saleId}`,
    startDate: "2026-07-01",
    endDate: "2026-07-05",
    distanceMiles: 1,
    address: "1 Test St",
    city: "Decatur",
    state: "GA",
    score,
    totalFindings: 1,
    topFindings: [],
    tally: { electronics: 0, kitsch: 0, collectibles: 0, furniture: 0 },
  };
}

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("skips (returns 0 for) mismatched-length vectors instead of throwing", () => {
    expect(() => cosine([1, 2, 3], [1, 2])).not.toThrow();
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosine([], [])).toBe(0);
  });

  it("returns 0 when a vector is all zeros (avoid NaN from divide-by-zero)", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("fuseRRF", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ranks a sale present in both lists above one present in only one list", () => {
    const a = stubSale("A");
    const b = stubSale("B");
    const c = stubSale("C");
    // A: lexical rank 0, semantic rank 0 (best possible in both)
    // B: lexical rank 1 only
    // C: semantic rank 1 only
    const fused = fuseRRF([a, b], [a, c]);
    expect(fused[0]!.saleId).toBe("A");
  });

  it("never suppresses an exact lexical match (AC11)", () => {
    const lexical = [stubSale("EXACT"), stubSale("OTHER")];
    const semantic = [stubSale("SEMANTIC-ONLY")];
    const fused = fuseRRF(lexical, semantic);
    const saleIds = fused.map((s) => s.saleId);
    expect(saleIds).toContain("EXACT");
    expect(saleIds).toContain("OTHER");
    expect(saleIds).toContain("SEMANTIC-ONLY");
  });

  it("produces a deterministic RRF score, not the original lexical score", () => {
    const lexical = [stubSale("A", 999)];
    const fused = fuseRRF(lexical, []);
    const k = 10; // default
    expect(fused[0]!.score).toBeCloseTo(1 / (k + 1));
  });

  it("respects an explicit k override", () => {
    const lexical = [stubSale("A")];
    const fused = fuseRRF(lexical, [], 1);
    expect(fused[0]!.score).toBeCloseTo(1 / (1 + 1));
  });

  it("respects SEMANTIC_RRF_K env override when k is omitted", () => {
    vi.stubEnv("SEMANTIC_RRF_K", "5");
    const lexical = [stubSale("A")];
    const fused = fuseRRF(lexical, []);
    expect(fused[0]!.score).toBeCloseTo(1 / (5 + 1));
  });

  it("returns an empty array for two empty lists", () => {
    expect(fuseRRF([], [])).toEqual([]);
  });
});

describe("bestPerSale", () => {
  it("keeps only the highest-cosine candidate per sale", () => {
    const candidates = [
      { saleId: "A", cosine: 0.5 },
      { saleId: "A", cosine: 0.9 },
      { saleId: "A", cosine: 0.1 },
      { saleId: "B", cosine: 0.3 },
    ];
    const best = bestPerSale(candidates);
    const a = best.find((c) => c.saleId === "A");
    const b = best.find((c) => c.saleId === "B");
    expect(a?.cosine).toBe(0.9);
    expect(b?.cosine).toBe(0.3);
    expect(best).toHaveLength(2);
  });

  it("picks the highest-cosine candidate regardless of input order (unordered fetch)", () => {
    const inOrder = bestPerSale([
      { saleId: "A", cosine: 0.2 },
      { saleId: "A", cosine: 0.95 },
    ]);
    const reversed = bestPerSale([
      { saleId: "A", cosine: 0.95 },
      { saleId: "A", cosine: 0.2 },
    ]);
    expect(inOrder[0]!.cosine).toBe(0.95);
    expect(reversed[0]!.cosine).toBe(0.95);
  });

  it("returns an empty array for no candidates", () => {
    expect(bestPerSale([])).toEqual([]);
  });
});
