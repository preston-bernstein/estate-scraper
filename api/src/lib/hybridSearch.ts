// Phase 2 hybrid search primitives: cosine similarity over raw vectors, a soft
// similarity floor, and Reciprocal Rank Fusion (RRF) to combine Phase 1 lexical
// results with Phase 2 semantic results without ever suppressing an exact lexical
// match (AC11, FR11). Pure functions, no I/O — the DB/embedding work lives in
// services/semanticSearch.ts.

import type { RankedSale } from "../services/discover.js";

// Cosine similarity between two vectors. Guards mismatched lengths (a malformed
// or foreign-dimension stored embedding) by returning 0 rather than throwing or
// comparing incompatible vector spaces — the caller is expected to treat 0 as
// "no match" (it will fall below SEMANTIC_MIN_COSINE) rather than crash the
// ranking pass (AC17/AC18).
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Minimum cosine similarity for a semantic candidate to be considered at all —
// a SOFT FLOOR only, to drop obvious noise before ranking. This is a CLIP-flavored
// launch guess (0.2), NOT a calibrated value: SigLIP's sigmoid training loss puts
// raw text-image cosine in a compressed, checkpoint-specific band with no
// established relationship to image-image similarity. It MUST be calibrated once
// against the real configured endpoint (sample real query embeddings against the
// corpus's image embeddings and inspect the observed distribution) before it is
// trusted as more than a coarse pre-filter — see docs/semantic-search/plan.md
// "Calibration step". Discrimination between results comes from RRF rank fusion
// below, not from this raw cosine number.
export const SEMANTIC_MIN_COSINE = Number(process.env.SEMANTIC_MIN_COSINE ?? 0.2);

// RRF default k. The web-IR convention of k=60 is nearly flat on a 5–20 item
// result list (the size of list this feature actually produces) and barely
// discriminates between ranks; a smaller k is appropriate here. Override via
// SEMANTIC_RRF_K for operators who want a fixed value.
const DEFAULT_RRF_K = 10;

function resolveK(k?: number): number {
  if (k !== undefined) return k;
  const envK = process.env.SEMANTIC_RRF_K;
  if (envK !== undefined) {
    const parsed = Number(envK);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DEFAULT_RRF_K;
}

// Reciprocal Rank Fusion: score(sale) = sum over lists containing it of 1/(k+rank).
// Every lexical member is seeded into the result set up front, so a sale present
// only in the lexical list (rank contributes 0 from semantic) still keeps its
// lexical-derived score and is never dropped by the semantic pass (AC11) — RRF
// structurally guarantees this without extra bookkeeping.
export function fuseRRF(lexical: RankedSale[], semantic: RankedSale[], k?: number): RankedSale[] {
  const kEff = resolveK(k);
  const scores = new Map<string, number>();
  const bySaleId = new Map<string, RankedSale>();

  lexical.forEach((sale, rank) => {
    bySaleId.set(sale.saleId, sale);
    scores.set(sale.saleId, (scores.get(sale.saleId) ?? 0) + 1 / (kEff + rank + 1));
  });
  semantic.forEach((sale, rank) => {
    if (!bySaleId.has(sale.saleId)) bySaleId.set(sale.saleId, sale);
    scores.set(sale.saleId, (scores.get(sale.saleId) ?? 0) + 1 / (kEff + rank + 1));
  });

  const fused = [...bySaleId.values()].map((sale) => ({
    ...sale,
    score: scores.get(sale.saleId) ?? 0,
  }));
  fused.sort((a, b) => b.score - a.score);
  return fused;
}

// Best-per-sale max-reduce: multiple candidate Findings can belong to the same
// Sale; the sale should be represented by its single highest-cosine Finding, not
// the first one encountered — the SQL fetch that produces these candidates is
// unordered, so "first encountered" would be arbitrary rather than correct.
export function bestPerSale<T extends { saleId: string; cosine: number }>(candidates: T[]): T[] {
  const bestBySale = new Map<string, T>();
  for (const candidate of candidates) {
    const existing = bestBySale.get(candidate.saleId);
    if (!existing || candidate.cosine > existing.cosine) {
      bestBySale.set(candidate.saleId, candidate);
    }
  }
  return [...bestBySale.values()];
}
