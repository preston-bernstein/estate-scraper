# Steps: Semantic Search

## Prerequisites
None.

## Implementation steps

### Step 1: Create thesaurus module with synonym and category expansion
**What**: Implement canonical thesaurus data structures and expandQuery function supporting synonym expansion and category→terms mapping across all 15 categories.
**Files**: api/src/lib/thesaurus.ts, api/src/lib/__tests__/thesaurus.test.ts
**Test**: Run `npm run test -- thesaurus.test.ts`, verify AC1 (couch→sofa), AC2 (couch→chaise/loveseat/sectional), AC3 (settee→category expansion), AC12 (deterministic output).
**Depends on**: none
**Parallelizable**: Yes

### Step 2: Integrate thesaurus into discover service searchSales
**What**: Modify searchSales to call expandQuery and query finding_items by category, merging category-matched findings with lexical search results.
**Files**: api/src/services/discover.ts
**Test**: Verify searchSales imports thesaurus, calls expandQuery with test queries, and merged result includes both text matches and category matches.
**Depends on**: Step 1
**Parallelizable**: No

### Step 3: Create discover service integration tests
**What**: Write tests for modified searchSales covering AC1–3 (expansion), AC9 (upcoming-sales scope), AC10 (sale-level regression), AC12 (determinism).
**Files**: api/src/services/__tests__/discover.test.ts
**Test**: Run `npm run test -- discover.test.ts`, verify all acceptance criteria pass and sale-level semantics preserved.
**Depends on**: Step 2
**Parallelizable**: No

### Step 4: Add embedQueryText to embed module with timeout and dimension tests
**What**: Extend api/src/lib/embed.ts with embedQueryText function (single string OpenAI /embeddings input, EMBED_SEARCH_TIMEOUT_MS default 3000, dim guard via parseEmbedResponse); extend embed.test.ts for dim-mismatch and timeout→null.
**Files**: api/src/lib/embed.ts, api/src/lib/__tests__/embed.test.ts
**Test**: Run `npm run test -- embed.test.ts`, verify AC8 (wrong-dim vectors rejected), AC5 (timeout returns null within budget).
**Depends on**: none
**Parallelizable**: Yes

### Step 5: Create hybridSearch module with RRF fusion and exact-match preservation
**What**: Implement cosine(a, b) similarity, MIN_COSINE_SIM threshold, and fuseRRF(lexical, semantic, k=60) ranking fusion ensuring exact matches are never suppressed.
**Files**: api/src/lib/hybridSearch.ts, api/src/lib/__tests__/hybridSearch.test.ts
**Test**: Run `npm run test -- hybridSearch.test.ts`, verify AC11 (exact lexical matches rank above semantic-only), RRF ordering correct.
**Depends on**: none
**Parallelizable**: Yes

### Step 6: Create queryEmbedCache module with single-call test
**What**: Implement getCachedQueryEmbedding with Map-based cache (keyed by trim().toLowerCase()), TTL + size cap, try/catch wrapper around embedQueryText that never throws.
**Files**: api/src/lib/queryEmbedCache.ts, api/src/lib/__tests__/queryEmbedCache.test.ts
**Test**: Run `npm run test -- queryEmbedCache.test.ts`, verify AC7 (duplicate queries hit cache, embedQueryText called exactly once).
**Depends on**: Step 4
**Parallelizable**: No

### Step 7: Create semanticSearch service with fallback and graceful degradation tests
**What**: Implement searchSalesHybrid: always compute lexical searchSales (fallback), conditionally compute query embedding via cache and semantic ranking (cosine threshold per finding image embeddings), RRF fusion, whole semantic path in try/catch→lexical.
**Files**: api/src/services/semanticSearch.ts, api/src/services/__tests__/semanticSearch.test.ts
**Test**: Run `npm run test -- semanticSearch.test.ts`, verify AC4 (unset EMBED_API_BASE→lexical no error), AC5 (timeout→lexical within budget), AC6 (semantic-only match ranks correctly).
**Depends on**: Step 2 (Phase 1), Steps 4, 5, 6 (Phase 2)
**Parallelizable**: No

### Step 8: Update discover route to use hybrid semantic search
**What**: Replace searchSales with searchSalesHybrid in GET /search route handler in api/src/routes/discover.ts (one-line change).
**Files**: api/src/routes/discover.ts
**Test**: Verify route import resolves, typecheck passes, route still returns valid sale results.
**Depends on**: Step 7
**Parallelizable**: No

## Rollback plan
All steps reversible via git.
