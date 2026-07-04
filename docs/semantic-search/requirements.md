# Requirements: Semantic Search

## Problem statement
Discover page search (`api/src/services/discover.ts` `searchSales`, wired to `ui/src/pages/DiscoverPage.tsx` SearchContent via `/api/discover/search?q=`) is substring LIKE matching over Finding descriptions and Sale title/city/state/address. A user who types "couch" gets nothing for a Finding whose description says "sofa" or "chaise lounge," even though both belong to the `seating` category (finding_items.category, ADR 0018) and describe the same kind of object a couch-shopper wants. The literal-string requirement makes search fail silently for exactly the everyday, non-technical vocabulary a casual user is most likely to type, undermining the Identifier's core promise of surfacing desirable Sales. This feature adds synonym- and category-aware matching (Phase 1) and, where the embedding endpoint is available, semantic similarity matching (Phase 2), while preserving the existing lexical path as a guaranteed fallback.

## Users / stakeholders
- Discover page end users searching by everyday object names (e.g., "couch," "record player," "chair set")
- The operator, who bears infra/token cost and requires no new external service and graceful degradation when EMBED_API_BASE is unavailable
- Future maintainers extending `api/src/lib/lexicon.ts` (currently maker-only) or the closed `finding_items.category` vocab (ADR 0018)

## Functional requirements

### Phase 1 — deterministic synonym/category expansion
1. The system shall expand a user's search query into a set of synonymous and category-sibling terms using a static, checked-in synonym/category thesaurus before executing the lexical match.
2. The system shall match a Finding whose description contains any expanded term, in addition to the literal query terms already matched today.
3. The system shall map each closed `finding_items.category` value (ADR 0018: seating, tables, case_goods, beds, lighting, clocks, art, ceramics_glass, silver, jewelry_watches, electronics, games_toys, instruments, kitsch, other) to a set of everyday query terms, so a query matching a category's terms also surfaces Findings/Items whose `finding_items.category` equals that category, regardless of exact description wording.
4. The system shall preserve current sale-level matching (title/city/state/address substring match) unchanged for Phase 1.
5. The system shall treat the thesaurus as data (a canonical→aliases/terms map), not inline code, so it can be extended without touching matching logic.
6. The system shall produce identical results for the same query and unchanged data on repeated calls (deterministic, no randomness or model call in the Phase 1 path).
7. The system shall NOT make any per-query call to an LLM or external inference endpoint as part of Phase 1 expansion.
8. The system shall continue to return results scoped to upcoming Sales only (`sales.endDate >= today`), matching current `searchSales` behavior.

### Phase 2 — semantic embedding / hybrid
9. The system shall, when `EMBED_API_BASE` is configured and reachable, embed the user's query text into the same SigLIP vector space used for Image embeddings (ADR 0016/0017) and rank candidate Findings/Images by cosine similarity to that query embedding.
10. The system shall cache a query's embedding in an in-process `Map` keyed by normalized query text, with a 5-minute TTL, so identical or repeated queries within that 5-minute window do not re-trigger an embedding call.
11. The system shall combine Phase 2 semantic ranking with Phase 1 lexical/category results into a single ranked result set (hybrid), rather than replacing lexical results outright, so exact-word matches are never suppressed by semantic re-ranking.
12. The system shall fall back to Phase 1 lexical-only search, with no user-visible error, when `EMBED_API_BASE` is unset or the embedding call fails/times out.
13. The system shall reject and discard any query embedding whose dimension does not match the frozen `EMBED_DIM` (ADR 0017), consistent with how Image embeddings are validated, rather than comparing across incompatible vector spaces.
14. The system shall apply a minimum cosine-similarity threshold, defaulted to 0.2, below which a Finding/Image is not considered a semantic match, to avoid surfacing unrelated results. This default is provisional: it MUST be calibrated once against the real SigLIP text-image cosine-similarity score distribution (sampling actual query embeddings against corpus Image embeddings) before it is trusted as a production floor. Ship with enough logging to perform that calibration.

### Additional hardening (Phase 1 & Phase 2)
15. **[Phase 1]** The system shall treat a multi-word query as a match against a Finding/Sale if ANY of its expanded terms (across all query words, including synonym/category expansions) matches — OR semantics, not AND — consistent with today's behavior. (Pins the expected behavior for queries like "record player" or "chair set" so it is testable.)
16. **[Phase 1]** The initial thesaurus content shall be curated as part of Phase 1 implementation (owner: the implementer, not deferred to a future pass). At minimum, the `seating` and `electronics` categories (ADR 0018) must be fully populated with everyday terms before launch — `electronics` because "record player" is a named target query for this feature. A fixed golden set of (query → expected Sale) pairs shall be defined and must all pass before Phase 1 ships; "does not crash" is not a sufficient bar.
17. **[Phase 2]** Findings whose `imageId` is null, or whose associated `images.embedding` is null (i.e., pre-backfill Findings that predate embedding generation), shall be excluded from Phase 2 semantic ranking, but shall remain matchable and visible via Phase 1 lexical/category matching.
18. **[Phase 2]** The system shall tolerate a malformed or wrong-dimension STORED corpus embedding (e.g., a legacy or corrupted `images.embedding` row) encountered while ranking, by skipping that row and continuing to rank the remaining candidates, never throwing or crashing the search request. This is distinct from FR13, which governs only the query embedding.
19. **[Phase 2]** The query-embedding cache (FR10) shall be bounded in memory by entry count, not merely by time: it shall enforce a hard cap of 512 entries, evicting the least-recently-used (LRU) entry when a new unique query would exceed the cap.

## Non-functional requirements
- Phase 1 (lexical + expansion) response time: p95 < 150ms for a search request, consistent with current in-process LIKE-query performance (no new I/O added).
- Phase 2 (embedding path) response time: p95 < 3500ms including the embedding call round-trip, when the endpoint is reachable. The embedding call itself is bounded by a 3000ms timeout; on exceeding it, the system falls back to Phase 1 lexical results rather than waiting further or hanging the request.
- Cost/token: Phase 1 must involve zero LLM/embedding API calls per search. Phase 2 must involve at most one embedding call per unique query (subject to caching per FR10/FR19), never one call per Finding/Item per search.
- Graceful degradation: total absence of `EMBED_API_BASE` (as in dev) must produce functionally correct, non-error search results via Phase 1 alone — this is a required, tested code path, not an edge case.
- Scale: expansion/matching must operate correctly against the current and growing Findings corpus (accumulates weekly per Scan, ADR: Scan never overwrites) without requiring a schema migration to `images`/`findings`/`finding_items` beyond what Phase 2 needs for storing/retrieving embeddings already persisted per ADR 0013.
- No new external service or infrastructure dependency is introduced; Phase 2 reuses the existing `EMBED_API_BASE` OpenAI-compatible `/embeddings` endpoint contract (ADR 0017).
- Security/cost: the search query shall be capped server-side to a maximum of 200 characters and ~16 terms before matching or embedding, to bound the SQL OR-list size and the embedding token cost of any single request.
- Observability: each search shall record whether it was served via hybrid (Phase 2) ranking or lexical-only fallback, and — on fallback — the reason (`disabled` / `timeout` / `error` / `dim-mismatch`), so operators can tell whether Phase 2 is actually running in production versus silently always falling back.
- Cost-abuse resistance: the embedding-triggering search path must be protected against an authenticated caller forcing unbounded unique-query embedding calls (e.g., via rate-limiting or an equivalent guard). The mechanism may be detailed in the implementation plan, but the protection itself is a requirement, not an optional hardening step.
- Secrets/logging: `embedQueryText` (and any wrapper around it) must never log the raw query text — only outcome/status (e.g., cache hit/miss, success/timeout/error, dimension) — matching the existing logging convention in `api/src/lib/embed.ts`.

## Constraints
- Must build on the existing `LEXICON` pattern in `api/src/lib/lexicon.ts` (canonical→aliases map), extended or paralleled for synonym/category terms rather than replaced.
- Must integrate with the closed 15-value `finding_items.category` vocabulary (ADR 0018); category expansion must not mint new categories or bypass the closed vocab.
- Must integrate with `searchSales(query)` in `api/src/services/discover.ts` and its consumer `ui/src/pages/DiscoverPage.tsx` SearchContent / `api.searchSales` / `/api/discover/search?q=`. The response SHAPE (`{ sales: RankedSale[] }`) is unchanged by this feature. Note: `RankedSale.score` CHANGES MEANING under Phase 2 — it becomes a fused RRF score (combining lexical rank and semantic rank), not a lexical hit-count — and is therefore not comparable across Phase 1 vs. Phase 2 responses, or across queries where one falls back to Phase 1 and another does not.
- Must reuse the existing frozen SigLIP embedding space (ADR 0016/0017) for any semantic comparison; must not introduce a second embedding model or a mixed-space comparison.
- Must respect `EMBED_DIM` as a hard guard (ADR 0017) — never compare or store a vector of the wrong dimension.
- Must remain scoped to upcoming Sales (`end_date >= today`), matching current search scope; this is not a requirement to change.
- Must not require a per-query LLM call (operator non-negotiable); synonym expansion must be deterministic and checked in.
- Must not require standing up a new external service; must degrade gracefully to lexical-only when `EMBED_API_BASE` is down or unset.

## Out of scope
- Fuzzy/typo-tolerant string matching (e.g., "cuoch" → "couch") — this feature addresses semantic/synonym gaps, not spelling correction.
- Ranking or scoring changes to `scoreFinding()` / Standout selection (Discover featured scroll) — this feature is search-only.
- Building or maintaining a general-purpose thesaurus/ontology service; the thesaurus is a static, project-owned data file.
- Structured intent/filter extraction from natural language — e.g., parsing "cheap chairs near me" into price, location, or quantity filters. Embeddings and term expansion cannot recover structured filters from free text, so this stays out of scope. This is distinct from matching a plain descriptive object phrase (e.g., "something to sit on"), which Phase 2 semantic matching is explicitly required to handle — see FR9/AC6.
- Any per-query LLM call for query rewriting, expansion, or re-ranking.
- Deal-finding, pricing, or market-value inference — out of scope for the Identifier per CONTEXT.md and unrelated to search relevance.
- Changes to the Hunt (saved keyword filter) matching engine, unless a follow-up explicitly extends this feature to Hunts.
- New UI beyond returning better-ranked results to the existing search box (no new filter controls, no synonym-suggestion UI) unless separately specified.

## Acceptance criteria
1. Given a Finding with description "mid-century sofa" and no other seating-related text, searching "couch" returns that Finding's Sale in results (Phase 1).
2. Given a Finding with description "chaise lounge" or "loveseat" or "sectional," searching "couch" returns each of those Findings' Sales (Phase 1 category-sibling match).
3. Given a Finding whose `finding_items.category` is `seating` but whose description uses a term not in the synonym list (e.g., "settee"), and "settee" is added to the seating category terms, searching "couch" surfaces it (validates category-level expansion, not just a fixed alias list).
4. Given `EMBED_API_BASE` is unset, searching "couch" still returns Phase 1 results with no error thrown and no unhandled rejection (graceful degradation).
5. Given `EMBED_API_BASE` is set but the endpoint times out or errors, the search request still completes and returns Phase 1 results within the stated fallback timeout, with no user-visible error.
6. Given `EMBED_API_BASE` is reachable, searching a query with no lexical or synonym overlap to any Finding description (e.g., a descriptive phrase like "something to sit on") but with strong image-embedding similarity to a seating Finding, that Finding's Sale is returned (Phase 2 semantic match).
7. Given the same query is issued twice within the 5-minute cache TTL, the second call does not trigger a second embedding API call (verified via call-count assertion in a test double for the embeddings endpoint).
8. Given a query embedding response of the wrong dimension (mismatched `EMBED_DIM`), the system discards it and falls back to Phase 1 results rather than comparing incompatible vectors.
9. Given a Sale outside the upcoming window (`end_date < today`), it is excluded from results under both Phase 1 and Phase 2 matching, matching current scope.
10. Given a query matching a Sale's title/city/state/address directly, that Sale is still returned (regression check: Phase 1 expansion does not remove or regress existing sale-level text matching).
11. Given Phase 1 and Phase 2 both produce candidate matches for a query, exact lexical matches are present in the final result set (not suppressed by hybrid re-ranking).
12. Repeated identical search requests against unchanged data return identical result sets and ordering (determinism check for the Phase 1 path).
13. Given an empty or whitespace-only query string, the search returns the current no-op behavior (no results / result set unchanged from the no-query state), triggers no embedding call, and never throws or surfaces an error.
14. Given a Finding matchable only via a synonym of one word in a multi-word query (e.g., "chair set" matching a Finding described as "dining chairs," or "record player" matching a Finding described as "turntable"), the Sale is returned — validating OR semantics across expanded terms rather than requiring every query word to match.
15. Given the curated thesaurus's golden set of (query → expected Sale) pairs, every pair passes, and the `seating` and `electronics` categories each have a non-empty, populated term list at launch.
16. Given a pre-backfill Finding with a null `imageId` or a null `images.embedding`, it is excluded from Phase 2 semantic ranking but is still returned when it matches via Phase 1 lexical/category search.
17. Given a candidate Finding/Image whose stored `images.embedding` is malformed or of the wrong dimension, the ranking process skips that row and completes successfully, returning results for the remaining valid candidates without crashing or erroring the request.
18. Given 513 unique queries are issued in sequence (exceeding the 512-entry cache cap) within the TTL window, the least-recently-used cached query embedding is evicted and a repeat of that evicted query triggers a new embedding API call (verified via call-count assertion).
19. Given a query longer than 200 characters or containing more than ~16 terms, the system caps it server-side before matching or embedding (verified by asserting the SQL OR-list size and/or embedding call payload does not grow unbounded with input length).
