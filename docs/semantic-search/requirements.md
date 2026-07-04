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
5. The system shall treat the thesaurus as data (a canonical→aliases/terms map, following the `LEXICON` pattern in `api/src/lib/lexicon.ts`), not inline code, so it can be extended without touching matching logic.
6. The system shall produce identical results for the same query and unchanged data on repeated calls (deterministic, no randomness or model call in the Phase 1 path).
7. The system shall NOT make any per-query call to an LLM or external inference endpoint as part of Phase 1 expansion.
8. The system shall continue to return results scoped to upcoming Sales only (`sales.endDate >= today`), matching current `searchSales` behavior.

### Phase 2 — semantic embedding / hybrid
9. The system shall, when `EMBED_API_BASE` is configured and reachable, embed the user's query text into the same SigLIP vector space used for Image embeddings (ADR 0016/0017) and rank candidate Findings/Images by cosine similarity to that query embedding.
10. The system shall cache a query's embedding (in-process or persistent, [mechanism TBD]) so identical or repeated queries within [cache window TBD] do not re-trigger an embedding call.
11. The system shall combine Phase 2 semantic ranking with Phase 1 lexical/category results into a single ranked result set (hybrid), rather than replacing lexical results outright, so exact-word matches are never suppressed by semantic re-ranking.
12. The system shall fall back to Phase 1 lexical-only search, with no user-visible error, when `EMBED_API_BASE` is unset or the embedding call fails/times out.
13. The system shall reject and discard any query embedding whose dimension does not match the frozen `EMBED_DIM` (ADR 0017), consistent with how Image embeddings are validated, rather than comparing across incompatible vector spaces.
14. The system shall apply a minimum cosine-similarity threshold [threshold TBD] below which a Finding/Image is not considered a semantic match, to avoid surfacing unrelated results.

## Non-functional requirements
- Phase 1 (lexical + expansion) response time: p95 < [threshold TBD] ms for a search request, consistent with current in-process LIKE-query performance (no new I/O added).
- Phase 2 (embedding path) response time: p95 < [threshold TBD] ms including the embedding call round-trip, when the endpoint is reachable; on timeout, fall back to Phase 1 within [timeout TBD] ms rather than hanging the request.
- Cost/token: Phase 1 must involve zero LLM/embedding API calls per search. Phase 2 must involve at most one embedding call per unique query (subject to caching per FR-10), never one call per Finding/Item per search.
- Graceful degradation: total absence of `EMBED_API_BASE` (as in dev) must produce functionally correct, non-error search results via Phase 1 alone — this is a required, tested code path, not an edge case.
- Scale: expansion/matching must operate correctly against the current and growing Findings corpus (accumulates weekly per Scan, ADR: Scan never overwrites) without requiring a schema migration to `images`/`findings`/`finding_items` beyond what Phase 2 needs for storing/retrieving embeddings already persisted per ADR 0013.
- No new external service or infrastructure dependency is introduced; Phase 2 reuses the existing `EMBED_API_BASE` OpenAI-compatible `/embeddings` endpoint contract (ADR 0017).

## Constraints
- Must build on the existing `LEXICON` pattern in `api/src/lib/lexicon.ts` (canonical→aliases map), extended or paralleled for synonym/category terms rather than replaced.
- Must integrate with the closed 15-value `finding_items.category` vocabulary (ADR 0018); category expansion must not mint new categories or bypass the closed vocab.
- Must integrate with `searchSales(query)` in `api/src/services/discover.ts` and its consumer `ui/src/pages/DiscoverPage.tsx` SearchContent / `api.searchSales` / `/api/discover/search?q=` — the public request/response contract should remain stable unless a documented change is called out.
- Must reuse the existing frozen SigLIP embedding space (ADR 0016/0017) for any semantic comparison; must not introduce a second embedding model or a mixed-space comparison.
- Must respect `EMBED_DIM` as a hard guard (ADR 0017) — never compare or store a vector of the wrong dimension.
- Must remain scoped to upcoming Sales (`end_date >= today`), matching current search scope; this is not a requirement to change.
- Must not require a per-query LLM call (operator non-negotiable); synonym expansion must be deterministic and checked in.
- Must not require standing up a new external service; must degrade gracefully to lexical-only when `EMBED_API_BASE` is down or unset.

## Out of scope
- Fuzzy/typo-tolerant string matching (e.g., "cuoch" → "couch") — this feature addresses semantic/synonym gaps, not spelling correction.
- Ranking or scoring changes to `scoreFinding()` / Standout selection (Discover featured scroll) — this feature is search-only.
- Building or maintaining a general-purpose thesaurus/ontology service; the thesaurus is a static, project-owned data file.
- Natural-language / conversational query understanding (e.g., "cheap chairs near me") beyond term expansion.
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
7. Given the same query is issued twice within [cache window TBD], the second call does not trigger a second embedding API call (verified via call-count assertion in a test double for the embeddings endpoint).
8. Given a query embedding response of the wrong dimension (mismatched `EMBED_DIM`), the system discards it and falls back to Phase 1 results rather than comparing incompatible vectors.
9. Given a Sale outside the upcoming window (`end_date < today`), it is excluded from results under both Phase 1 and Phase 2 matching, matching current scope.
10. Given a query matching a Sale's title/city/state/address directly, that Sale is still returned (regression check: Phase 1 expansion does not remove or regress existing sale-level text matching).
11. Given Phase 1 and Phase 2 both produce candidate matches for a query, exact lexical matches are present in the final result set (not suppressed by hybrid re-ranking).
12. Repeated identical search requests against unchanged data return identical result sets and ordering (determinism check for the Phase 1 path).
