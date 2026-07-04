# Plan: Semantic Search

## Approach
Phase 1 adds a checked-in synonym/category thesaurus (`api/src/lib/thesaurus.ts`, sibling to `lexicon.ts`) that expands query terms before the existing lexical LIKE match in `searchSales`, plus a `finding_items.category` join so a query like "couch" also pulls every `seating` row regardless of description wording — zero API calls, fully deterministic. Phase 2 wraps Phase 1 with a new orchestrator that embeds the query into the frozen SigLIP space, ranks Findings by cosine similarity to their (already-persisted) image embedding, and fuses that ranking with the Phase 1 result via Reciprocal Rank Fusion (RRF) — falling back to Phase 1 alone whenever the embedding endpoint is unset, slow, erroring, or returns the wrong dimension. The two phases touch almost disjoint files: Phase 1 owns `lib/thesaurus.ts` + the lexical half of `services/discover.ts`; Phase 2 adds new files and only swaps one function call in the route, so they can be built in parallel worktrees and merged independently.

## Architecture

```
Phase 1 (always runs, no I/O beyond SQLite)
  searchSales(query)
    ├─ expandQuery(terms)              [lib/thesaurus.ts]
    │    → literalTerms, expandedTerms, categories
    ├─ LIKE match over findings.description using expandedTerms
    ├─ finding_items.category IN (categories) → extra finding ids
    ├─ sale title/city/state/address substring match  (unchanged)
    └─ → RankedSale[]   (unchanged shape)

Phase 2 (additive orchestrator; only reachable via route swap)
  routes/discover.ts  GET /search
    → searchSalesHybrid(query)          [services/semanticSearch.ts]
         ├─ lexical = searchSales(query)         (Phase 1, always computed — the fallback)
         ├─ if !embeddingEnabled() → return lexical
         ├─ vec = getCachedQueryEmbedding(query)  [lib/queryEmbedCache.ts → lib/embed.ts embedQueryText]
         │    (in-process cache; short timeout; dim-guard; any failure → null)
         ├─ if vec === null → return lexical
         ├─ semantic = rankSalesBySimilarity(vec, upcomingScope)  [services/semanticSearch.ts]
         │    (findings JOIN images ON imageId, blobToFloat32, cosine, threshold, group→best-per-sale)
         ├─ fused = fuseRRF(lexical, semantic)    [lib/hybridSearch.ts]
         └─ return fused   (RankedSale[], same shape; lexical members always retained)
```

Everything semantic is wrapped in try/catch at the orchestrator boundary so any unexpected failure (network, parse, cosine on malformed blob) degrades to the Phase 1 result rather than 500ing the request.

## Data model
No data model changes. Phase 1 needs no new columns — it reads `finding_items.category`, which already exists (ADR 0018). Phase 2 needs no new columns either: Findings don't carry their own embedding, but each Finding has `imageId` referencing `images`, and `images.embedding`/`embedDim` are already persisted at scan time (ADR 0013/0016/0017) — Phase 2 joins `findings → images` at query time and reuses `blobToFloat32` from `lib/embed.ts`. Findings with a null `imageId` (pre-backfill) are simply excluded from the semantic ranking pass; they remain visible via the Phase 1 lexical path. The query-embedding cache is in-process memory, not a table.

## API / interface contract
- `/api/discover/search?q=` request/response contract is unchanged: `{ sales: RankedSale[] }`. No new query params, no new response fields. Phase 2 is invisible at the wire level — same endpoint, same shape, better ranking/recall.
- New internal signatures:
  - `lib/thesaurus.ts`: `export function expandQuery(terms: string[]): { literalTerms: string[]; expandedTerms: string[]; categories: FindingCategory[] }`
  - `lib/embed.ts` (additive export): `export async function embedQueryText(text: string): Promise<number[] | null>` — same OpenAI `/embeddings` wire as `embedImages`, single string input, short request timeout (search is a live user request, not a batch scan job), reuses `parseEmbedResponse` for the `EMBED_DIM` guard.
  - `lib/queryEmbedCache.ts`: `export async function getCachedQueryEmbedding(query: string): Promise<number[] | null>` — never throws; wraps `embedQueryText`, absorbs errors/timeouts, returns `null` on any failure or when embeddings are disabled.
  - `lib/hybridSearch.ts`: `export function fuseRRF(lexical: RankedSale[], semantic: RankedSale[], k?: number): RankedSale[]`
  - `services/semanticSearch.ts`: `export async function searchSalesHybrid(query: string): Promise<RankedSale[]>` — becomes the route's entry point in Phase 2; `searchSales` itself keeps its existing signature and stays the Phase 1 entry point / fallback.

## Integration points

### Phase 1
- `api/src/lib/thesaurus.ts` (NEW) — canonical→everyday-term synonym map (e.g. `sofa: ["couch", "chaise", "chaise lounge", "loveseat", "sectional", "settee", "davenport"]`) plus a `category → everyday terms` map covering all 15 `finding_items.category` values (ADR 0018), an alias index built the same way `ALIAS_INDEX` is built in `lexicon.ts`, and `expandQuery()`. Pure data + pure function, no DB/network access — this is what FR5/FR6/FR7 require.
- `api/src/services/discover.ts` — `searchSales()`: call `expandQuery(terms)`; build the description LIKE clause over `expandedTerms` (a superset of the literal terms, so literal matching is preserved — FR4/AC10); additionally query `finding_items` for rows where `category IN (categories)` scoped to `upcomingSaleIds`, and merge those finding ids into the matched set before building `RankedSale[]`. `getDiscoverData()` and the sale-text-match block are untouched.
- `api/src/db/schema.ts` — no edits; `discover.ts` imports the already-exported `findingItems` table.
- `api/src/lib/__tests__/thesaurus.test.ts` (NEW) — expansion correctness, determinism (same input → same output, no Date/Math.random), the "add settee to seating terms" acceptance case (AC3).
- `api/src/services/__tests__/discover.test.ts` (NEW) — couch→sofa/chaise/loveseat/sectional (AC1, AC2), category-only match via `finding_items.category` (AC3), upcoming-scope exclusion (AC9), sale-level title/city regression (AC10), determinism (AC12).

### Phase 2
- `api/src/lib/embed.ts` — add `embedQueryText()` alongside the existing `embedImages()`/`embedBatch()`; reuses `EMBED_API_BASE`, `EMBED_MODEL`, `parseEmbedResponse`, `embeddingEnabled()`. New short-timeout constant (e.g. `EMBED_SEARCH_TIMEOUT_MS`, default 3000ms) distinct from the 120s batch-scan timeout, since this sits on a live request path (FR12/AC5). Phase 1 never touches this file, so there's no merge conflict.
- `api/src/lib/queryEmbedCache.ts` (NEW) — `Map<string, { vec: number[]; expiresAt: number }>` keyed by normalized (`trim().toLowerCase()`) query text, TTL + size-capped (simple LRU-by-insertion-order eviction), wraps `embedQueryText` in try/catch so callers never see a throw (FR10, AC7).
- `api/src/lib/hybridSearch.ts` (NEW) — `cosine(a: number[], b: number[]): number`, a `MIN_COSINE_SIM` threshold constant (env-overridable, e.g. `SEMANTIC_MIN_COSINE`, default `0.2`), and `fuseRRF()`.
- `api/src/services/semanticSearch.ts` (NEW) — `searchSalesHybrid()`: calls `searchSales()` (Phase 1) for the baseline/fallback, short-circuits to it when disabled/timeout/dim-mismatch/error, otherwise queries `findings JOIN images` scoped to upcoming sale ids with non-null `embedding`, computes cosine per Finding via `blobToFloat32`, drops sub-threshold results, takes the best-scoring Finding per Sale to build a semantic `RankedSale[]` (same shape, reusing sale metadata already fetched inside `searchSales`'s db round trip — refetched here independently to keep this file decoupled from Phase 1's internals), then calls `fuseRRF`.
- `api/src/routes/discover.ts` — one-line change: the `GET /search` handler calls `searchSalesHybrid` instead of `searchSales`. `GET /` (`getDiscoverData`) is untouched.
- `api/src/lib/__tests__/embed.test.ts` — extend with `embedQueryText` cases: dimension-mismatch discard (AC8), timeout → null (AC5 building block).
- `api/src/lib/__tests__/queryEmbedCache.test.ts` (NEW) — call-count assertion against a mocked endpoint proving a repeated query embeds once (AC7).
- `api/src/lib/__tests__/hybridSearch.test.ts` (NEW) — RRF ordering, exact-lexical-never-suppressed (AC11).
- `api/src/services/__tests__/semanticSearch.test.ts` (NEW) — `EMBED_API_BASE` unset → Phase 1 passthrough (AC4), endpoint timeout/error → Phase 1 passthrough within fallback budget (AC5), semantic-only match with no lexical overlap (AC6).

## Technology choices
- **RRF (Reciprocal Rank Fusion)** for combining lexical and semantic rankings: simple (`score += 1/(k + rank)`), no tuning of relative score magnitudes between an ad-hoc lexical score and a cosine similarity (which live on incomparable scales), and it structurally guarantees anything present in the lexical list keeps a nonzero, present score — satisfying "exact matches never suppressed" (FR11/AC11) without extra bookkeeping.
- **JS cosine over `blobToFloat32`, no sqlite-vec / vector index**: the corpus is scoped to upcoming Sales' Findings only (small, bounded working set per ADR 0018's own precedent of in-process scoring), and adding a vector-search dependency would be a new piece of infra to operate and reason about for a query pattern that's a handful of cosine dot-products in JS. Revisit only if upcoming-sale Finding counts grow into the tens of thousands.
- **In-process `Map` with TTL, not a DB-backed or Redis cache**: satisfies FR10's "cache query embeddings" without a new external service (explicit operator non-negotiable); acceptable to lose the cache on process restart since the cost being avoided is per-search embedding calls within a session, not cross-deploy durability.
- **FTS5 — not adopted.** Called out and rejected: FTS5 would help ranking/relevance for large free-text corpora, but the current LIKE-scan approach is already fast enough at this corpus size, FTS5 needs a virtual-table migration + trigger-based sync with `findings`, and neither Phase's acceptance criteria requires it. Revisit if Findings volume or query latency becomes a real problem.

## Risk areas
- **Cosine threshold and RRF's `k` are unverified constants** (`SEMANTIC_MIN_COSINE`, `k=60` convention) — SigLIP text-image cosine similarity has different scale characteristics than image-image similarity the frozen model was validated for (ADR 0017); the default may need retuning once real query embeddings are observed, and a bad threshold silently drops or floods semantic results without erroring.
- **Independent re-querying of upcoming sales in `semanticSearch.ts`** (rather than sharing `searchSales`'s db round trip) trades a small amount of duplicate I/O for file/module independence between phases; if Sales volume grows this duplication should be revisited, but it keeps the two phases mergeable without shared internal APIs.
- **Thesaurus coverage is a manual, static list** — like `LEXICON`, it only helps queries whose everyday term was anticipated (couch, chaise, loveseat, sectional, settee for `seating`); an unanticipated synonym gets no expansion in Phase 1, and Phase 2's semantic path is the only backstop for that gap, so Phase 2 being down (or not yet merged) reintroduces the exact vocabulary-mismatch problem this feature exists to fix.
- **Timeout-based fallback (FR12/AC5) is a race against a live HTTP request inside a user-facing search call** — an `EMBED_API_BASE` that's slow-but-not-down (e.g., GPU broker queued behind other jobs) risks making every search feel slow even though it "gracefully falls back," unless the short timeout (~3s) is tuned well below user-perceived latency tolerance.
- **`finding_items.category` join for category-level expansion (FR3) adds a second query to every Phase 1 search that has a category-mapped term** — for the vast majority of everyday-object queries this is the common case, so it's not a rare-path cost; acceptable at current scale but worth a query-plan check (index on `finding_items.category` and `.saleId` already exist per schema) if search latency regresses.
