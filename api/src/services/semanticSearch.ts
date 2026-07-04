// Phase 2: hybrid lexical + SigLIP semantic search (ADR 0016/0017), gated behind
// the SEMANTIC_SEARCH_ENABLED kill switch so merging this file never activates an
// uncalibrated semantic path in production — flip the env var to enable/disable
// with no redeploy (see docs/semantic-search/steps.md "Rollback plan").
//
// searchSales() (Phase 1 lexical) is ALWAYS computed first and is the guaranteed
// fallback. The entire semantic block is wrapped in one try/catch: any failure —
// disabled, embed-null, timeout, malformed row, unexpected error — returns the
// lexical result unchanged rather than 500ing the request. Every call logs its
// mode ("hybrid" vs "lexical-fallback:<reason>") so a silently-broken Phase 2 is
// observable in production instead of quietly always falling back. The raw query
// text is NEVER logged (matches lib/embed.ts's logging convention).

import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { findings, images, sales } from "../db/schema.js";
import { todayIsoDate } from "../lib/date.js";
import { EMBED_MODEL, blobToFloat32, embeddingEnabled } from "../lib/embed.js";
import { SEMANTIC_MIN_COSINE, bestPerSale, cosine, fuseRRF } from "../lib/hybridSearch.js";
import { getCachedQueryEmbedding } from "../lib/queryEmbedCache.js";
import { type DiscoverFinding, type RankedSale, searchSales } from "./discover.js";
import { thumbUrlForImageId } from "./sales.js";

type UpcomingSale = Awaited<ReturnType<typeof fetchUpcomingSales>>[number];

type SemanticCandidateRow = {
  saleId: string;
  findingId: number;
  imageId: number | null;
  imageUrl: string;
  description: string;
  embedding: Buffer | null;
};

type SemanticCandidate = { saleId: string; cosine: number; row: SemanticCandidateRow };

async function fetchUpcomingSales() {
  const today = todayIsoDate();
  return db.select().from(sales).where(gte(sales.endDate, today));
}

// Builds a RankedSale for a semantic-only match (no lexical overlap) from the
// sale row plus its single best-cosine candidate Finding. `score` here is a
// placeholder (the cosine) that fuseRRF immediately overwrites with the fused
// RRF score — it only matters for the pre-fusion sort order.
function buildSemanticRankedSale(saleRow: UpcomingSale, candidate: SemanticCandidate): RankedSale {
  const finding: DiscoverFinding = {
    id: candidate.row.findingId,
    imageUrl: candidate.row.imageUrl,
    thumbUrl: thumbUrlForImageId(candidate.row.imageId),
    description: candidate.row.description,
    score: candidate.cosine,
    tag: "furniture",
  };
  return {
    saleId: saleRow.saleId,
    title: saleRow.title,
    url: saleRow.url,
    startDate: saleRow.startDate,
    endDate: saleRow.endDate,
    distanceMiles: saleRow.distanceMiles,
    address: saleRow.address,
    city: saleRow.city,
    state: saleRow.state,
    score: candidate.cosine,
    totalFindings: 1,
    topFindings: [finding],
    tally: { electronics: 0, kitsch: 0, collectibles: 0, furniture: 0 },
  };
}

export async function searchSalesHybrid(query: string): Promise<RankedSale[]> {
  // Phase 1 lexical search is ALWAYS computed first — it is the guaranteed
  // fallback for every short-circuit below, not just the disabled case.
  const lexical = await searchSales(query);

  if (process.env.SEMANTIC_SEARCH_ENABLED !== "true" || !embeddingEnabled()) {
    console.error("[search] lexical-fallback:disabled");
    return lexical;
  }

  try {
    const vec = await getCachedQueryEmbedding(query);
    if (!vec) {
      console.error("[search] lexical-fallback:embed-null");
      return lexical;
    }

    const upcomingSales = await fetchUpcomingSales();
    if (upcomingSales.length === 0) {
      console.error("[search] hybrid (no upcoming sales)");
      return lexical;
    }
    const upcomingSaleIds = upcomingSales.map((s) => s.saleId);
    const saleById = new Map(upcomingSales.map((s) => [s.saleId, s]));

    // Candidates scoped to upcoming sales only (AC9), filtered to embeddings that
    // exist and were generated under the currently-configured model (a post-scan
    // pass can lag new Findings or be left over from a prior EMBED_MODEL) — a
    // bare imageId join would silently score against stale/foreign vectors.
    const rows = await db
      .select({
        saleId: findings.saleId,
        findingId: findings.id,
        imageId: findings.imageId,
        imageUrl: findings.imageUrl,
        description: findings.description,
        embedding: images.embedding,
      })
      .from(findings)
      .innerJoin(images, eq(findings.imageId, images.id))
      .where(
        and(
          inArray(findings.saleId, upcomingSaleIds),
          isNotNull(images.embedding),
          eq(images.embedModel, EMBED_MODEL),
        ),
      );

    const candidates: SemanticCandidate[] = [];
    for (const row of rows) {
      try {
        if (!row.embedding) continue;
        const rowVec = blobToFloat32(row.embedding);
        // Per-row dimension guard, independent of the embedModel filter above:
        // tolerate a malformed/wrong-dimension stored embedding by skipping just
        // that row rather than throwing (AC18).
        if (rowVec.length !== vec.length) continue;
        const sim = cosine(rowVec, vec);
        if (sim < SEMANTIC_MIN_COSINE) continue;
        candidates.push({ saleId: row.saleId, cosine: sim, row });
      } catch {
        continue; // malformed row — keep ranking the rest of the corpus
      }
    }

    // Best-per-sale: a Sale can have multiple candidate Findings; represent it by
    // its single highest-cosine Finding (explicit max-reduce, not first-seen —
    // the SQL fetch above is unordered).
    const best = bestPerSale(candidates).sort((a, b) => b.cosine - a.cosine);

    const semantic: RankedSale[] = [];
    for (const candidate of best) {
      const saleRow = saleById.get(candidate.saleId);
      if (!saleRow) continue;
      semantic.push(buildSemanticRankedSale(saleRow, candidate));
    }

    const fused = fuseRRF(lexical, semantic);
    console.error(
      `[search] hybrid (candidateRows=${rows.length}, semanticMatches=${semantic.length})`,
    );
    return fused;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.error(`[search] lexical-fallback:error (${msg})`);
    return lexical;
  }
}
