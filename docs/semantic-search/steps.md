# Steps: Semantic Search

## Prerequisites
None.

## Implementation steps

### Phase 1: Thesaurus & Integration

### Step 1a: Create thesaurus data file with category and synonym definitions
**What**: Create thesaurus data structure defining all 15 categories, their synonym mappings, and term→category reverse lookup. Reuse Category type from api/src/lib/items.ts (do not create new FindingCategory type).
**Files**: api/src/lib/thesaurus.ts (data export only)
**Test**: Run `npm run test -- thesaurus.test.ts` (created in 1c), verify data loads, AC1 (couch exists in synonyms), AC3 (settee→category data present).
**Depends on**: none
**Parallelizable**: Yes

### Step 1b: Implement expandQuery function with LIKE-metacharacter escaping
**What**: Implement expandQuery(query: string) that safely escapes LIKE metacharacters (%, _) in original query terms before expansion, then expands each term via thesaurus synonyms and category→terms mapping. Return expanded list suitable for SQL LIKE or category match.
**Files**: api/src/lib/thesaurus.ts (expandQuery function)
**Test**: Run `npm run test -- thesaurus.test.ts`, verify AC1–2 (couch→sofa/chaise/loveseat/sectional), escaping prevents SQL injection via LIKE wildcards.
**Depends on**: Step 1a
**Parallelizable**: Yes

### Step 1c: Create thesaurus unit tests
**What**: Write comprehensive unit tests for thesaurus module covering synonym expansion, category expansion, determinism, and edge cases.
**Files**: api/src/lib/__tests__/thesaurus.test.ts
**Test**: Run `npm run test -- thesaurus.test.ts`, verify AC1 (couch→sofa), AC2 (couch→chaise/loveseat/sectional), AC3 (settee→category expansion), AC12 (deterministic output), empty-query handling.
**Depends on**: Step 1a, Step 1b
**Parallelizable**: No

### Step 2: Integrate thesaurus into discover service and create test file
**What**: Modify searchSales in api/src/services/discover.ts to call expandQuery and merge category-matched findings with lexical results. Define scoring rule: category-only matches (zero LIKE hits) count the same as literal keyword hits toward the sale score. Create api/src/services/__tests__/discover.test.ts with basic integration tests verifying the modified searchSales works in isolation.
**Files**: api/src/services/discover.ts, api/src/services/__tests__/discover.test.ts
**Test**: Run `npm run test -- discover.test.ts`, verify searchSales imports thesaurus, calls expandQuery, merged result includes both text matches and category matches, category-only matches contribute to sale score equally.
**Depends on**: Step 1c
**Parallelizable**: No

### Step 3: Create comprehensive discover service integration tests with order verification
**What**: Write additional integration tests for searchSales covering AC1–3 (expansion), AC9 (upcoming-sales scope), AC10 (sale-level regression), AC12 (determinism). Crucially, pin result ORDER (not just presence) so that AC10 regressions cannot silently break. Test with mixed category-only and lexical matches to verify order consistency.
**Files**: api/src/services/__tests__/discover.test.ts (extend with comprehensive tests)
**Test**: Run `npm run test -- discover.test.ts`, verify all acceptance criteria pass, sale-level result order is deterministic and correct under mixed match types, no silent regressions.
**Depends on**: Step 2
**Parallelizable**: No

### Phase 2: Embeddings & Semantic Search

### Step 4: Add embedQueryText to embed module with query-length cap and logging safeguards
**What**: Extend api/src/lib/embed.ts with embedQueryText(query: string) that enforces max-query-length cap (200 characters) before calling OpenAI, respects EMBED_SEARCH_TIMEOUT_MS default 3000, guards via parseEmbedResponse. Never log raw query text. Extend embed.test.ts for dim-mismatch, timeout→null, and max-length enforcement.
**Files**: api/src/lib/embed.ts, api/src/lib/__tests__/embed.test.ts
**Test**: Run `npm run test -- embed.test.ts`, verify AC8 (wrong-dim vectors rejected), AC5 (timeout returns null within budget), 200-char cap enforced, raw query text never logged.
**Depends on**: none
**Parallelizable**: Yes

### Step 5: Create hybridSearch module with RRF fusion, vector guards, and per-sale max-reduce
**What**: Implement cosine(a, b) similarity (guard against wrong-length vectors), MIN_COSINE_SIM threshold, fuseRRF(lexical, semantic, k) ranking fusion with env-overridable k parameter (default scaled to small result lists, e.g., k=10). Add bestPerSale(results) helper that reduces multiple findings per sale to highest-cosine match, ensuring the best semantic match wins regardless of fetch order. Ensure exact matches are never suppressed.
**Files**: api/src/lib/hybridSearch.ts, api/src/lib/__tests__/hybridSearch.test.ts
**Test**: Run `npm run test -- hybridSearch.test.ts`, verify AC11 (exact lexical matches rank above semantic-only), RRF ordering correct, cosine guards mismatched vectors, bestPerSale reduces correctly and highest-cosine finding wins for each sale.
**Depends on**: none
**Parallelizable**: Yes

### Step 6: Create queryEmbedCache module with TTL and LRU eviction tests
**What**: Implement getCachedQueryEmbedding with Map-based cache (keyed by trim().toLowerCase()), TTL expiry, size cap with LRU eviction, and try/catch wrapper around embedQueryText that never throws. Include comprehensive tests for cache hits, TTL expiry, and LRU eviction.
**Files**: api/src/lib/queryEmbedCache.ts, api/src/lib/__tests__/queryEmbedCache.test.ts
**Test**: Run `npm run test -- queryEmbedCache.test.ts`, verify AC7 (duplicate queries hit cache, embedQueryText called exactly once), TTL expiry evicts old entries, LRU eviction respects size cap, cache degrades gracefully on embedQueryText failure.
**Depends on**: Step 4
**Parallelizable**: No

### Step 7: Create semanticSearch service and update discover route with kill-switch
**What**: Implement searchSalesHybrid: always compute lexical searchSales (fallback), conditionally compute query embedding via cache and semantic ranking (cosine threshold per finding image embeddings filtered by `embedding IS NOT NULL AND embed_model = EMBED_MODEL` and `end_date >= today`), RRF fusion, whole semantic path in try/catch→lexical. In api/src/routes/discover.ts, replace searchSales with searchSalesHybrid and add SEMANTIC_SEARCH_ENABLED env kill-switch (false = skip semantic, return lexical only). Verify via route-level integration test.
**Files**: api/src/services/semanticSearch.ts, api/src/services/__tests__/semanticSearch.test.ts, api/src/routes/discover.ts
**Test**: Run `npm run test -- semanticSearch.test.ts`, verify AC4 (unset EMBED_API_BASE→lexical no error), AC5 (timeout→lexical within budget), AC6 (semantic-only match ranks correctly), AC9 (candidates exclude end_date < today and unembedded findings), PARTIAL-embedding corpus test (mixed embedded and unembedded findings), route-level test confirms SEMANTIC_SEARCH_ENABLED kill-switch works and route returns valid results.
**Depends on**: Step 2 (Phase 1), Steps 4, 5, 6 (Phase 2)
**Parallelizable**: No

### Step 8: Calibration—verify embedding quality and set SEMANTIC_MIN_COSINE threshold
**What**: Create a one-time calibration script or documented procedure to sample ~20–30 (query, matching-image) pairs from real corpus, call the deployed SigLIP embedding endpoint with each pair, verify that matching pairs score higher cosine similarity than random unrelated pairs (smoke test), then analyze the observed distribution and set SEMANTIC_MIN_COSINE constant from real data. Document the calibration results and threshold rationale.
**Files**: api/scripts/calibrate-semantic.ts (or docs/semantic-search/calibration-results.md)
**Test**: Run calibration script or follow documented procedure, verify SigLIP embedding quality via smoke test, confirm SEMANTIC_MIN_COSINE is set from observed distribution.
**Depends on**: Step 7
**Parallelizable**: No

## Rollback plan
All Phase 1 and Phase 2 steps reversible via git revert. For production route enablement: rollback = flip `SEMANTIC_SEARCH_ENABLED` environment variable to `false` (no redeploy required; service immediately disables semantic path and falls back to lexical-only searchSales). If emergency redeploy needed, git revert the route changes in api/src/routes/discover.ts and redeploy.
