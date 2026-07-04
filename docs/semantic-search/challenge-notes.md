# Spec Challenge Notes

## Agents run
- Requirements Auditor (sonnet): 11 issues found, 10 accepted
- Scope & Dependency Auditor (sonnet): 9 issues found, 8 accepted
- Design Devil's Advocate (sonnet): 8 issues found, 8 accepted
- Implementation Realist (sonnet): 8 issues found, 8 accepted
- Steps & Sequencing Critic (sonnet): 8 issues found, 8 accepted
- Data Model Critic (sonnet): 6 issues found, 5 accepted
- Security/Threat Auditor (sonnet): 4 issues found, 4 accepted

## Changes made
- **SigLIP semantic path de-risked.** Two load-bearing corrections: (1) the `0.2` cosine floor was a CLIP-flavored guess — SigLIP's sigmoid loss puts text-image cosine in a compressed, checkpoint-specific band unrelated to the image-image similarity ADR 0017 validated; the spec now relies on RRF *rank* fusion for discrimination and requires a one-time calibration pass (new steps entry) before any absolute floor is trusted. (2) Added a required (text,image) smoke test because many OpenAI-compatible SigLIP servers expose the text tower separately — sending text to a vision-only model can silently return a right-dimension garbage vector that passes the `EMBED_DIM` guard.
- **Corrected concrete implementation facts.** `FindingCategory` doesn't exist — the real type is `Category` from `api/src/lib/items.ts` (a cross-module dep the isolation claim now acknowledges). `finding_items` is currently write-only and `discover.ts` already has a rival `tagFinding` regex classifier feeding the `tally`; the spec now states the reconciliation stance. Phase 2's candidate query must filter `images.embedding IS NOT NULL AND embed_model = EMBED_MODEL` (embeddings lag, fail-open to null, or predate a model change), and best-per-sale must be an explicit max-by-cosine reduce (SQL fetch is unordered).
- **Operability + cost + safety.** Added: hybrid-vs-lexical-fallback observability (Phase 2 can silently no-op otherwise), a `SEMANTIC_SEARCH_ENABLED` kill-switch (rollback without redeploy), server-side query cap (200 chars / ~16 terms) + rate-limit guard on the embedding branch (FrugalGPT cost-abuse), LIKE-metacharacter escaping, true-LRU (was FIFO) with size cap, and a golden-set quality acceptance criterion (the plumbing tests never proved the feature actually improves search).
- **Resolved all `[TBD]` constants** to concrete testable values (cache TTL 5m / cap 512, embed timeout 3000ms, p95 targets) and fixed the AC6-vs-out-of-scope contradiction (narrowed out-of-scope to *structured* price/location intent, not descriptive object phrases).
- **Steps restructured** 8→10: split the oversized thesaurus step (1a data / 1b expandQuery+escaping / 1c tests), merged the trivial route swap into Step 7 (now also adds the kill-switch + route test), and added the SigLIP calibration step.

## Critiques rejected
- Pure-scale alarms (JS cosine "could reach thousands of vectors") were not accepted as blocking at the current corpus size — but the cheap mitigation (instrument per-search candidate count + cosine wall-time) WAS accepted so the "revisit if it grows" trigger is observable.
- "Unused exports during incremental Phase-2 merge" (informational) — folded into a plan note rather than a spec change, since the QA gate's fallow dead-code check will enforce wiring-before-commit anyway.

## Open questions requiring human input
- **Serving-stack text tower**: does the production `EMBED_API_BASE` (SigLIP over the broker) actually expose the text tower under the configured `EMBED_MODEL`? The calibration/smoke step will answer this empirically, but if it doesn't, Phase 2 semantic needs a different embedding source. Not a blocker for Phase 1.
- **Category vs tally reconciliation**: the spec documents the inconsistency (a Finding matched via `finding_items.category` may be tallied differently by `tagFinding`); confirm whether unifying these two classifiers is desired now or deferred.
