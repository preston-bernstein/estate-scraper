# Spec Challenge Notes

## Agents run
- Requirements Auditor (haiku): 10 issues found, 10 accepted
- Scope & Dependency Auditor (sonnet): 11 issues found, 11 accepted
- Design Devil's Advocate (sonnet): 9 issues found, 9 accepted
- Implementation Realist (sonnet): 16 issues found, 15 accepted, 1 noted as pre-existing (out of scope)
- Steps & Sequencing Critic (sonnet): 22 issues found, 22 accepted
- Data Model Critic (sonnet): 4 issues found, 2 accepted, 2 rejected (CHECK constraint, enum rigidity — over-engineering vs. existing schema conventions)
- Security/Threat Auditor (haiku): 8 issues found, 6 accepted, 2 rejected (path-traversal on a local operator-run CLI tool, pod-ID redaction in alerts — both overstated for the actual threat model)

## Changes made
- **Fixed a real, previously-solved bug about to be reintroduced.** `api/src/lib/vision.ts` already documents that Qwen3-VL models emit empty responses under low token budgets unless chain-of-thought is suppressed (`/no_think`) — that fix exists only on the local-gate path, never on `runVisionManaged` (the function this cutover routes Tier-2 through). Now an explicit, in-scope risk with a required calibration check and named fix paths.
- **Closed the "calibration might silently validate the wrong backend" hole.** No `dotenv` loading exists anywhere in this repo for one-off SSH commands, and `ReferenceRecord` had no field recording which backend actually served each result — a forgotten env-export could produce a "RunPod calibration" that actually ran against local Ollama with zero way to detect it. Added a `backend` provenance field and explicit `.env`-sourcing instructions.
- **Fixed a real deploy-ordering bug**: the watchdog was being enabled (old Step 12) *after* the RunPod API key was wired (old Step 16) in one direction, while a separate finding showed a dedicated pod could be provisioned (old Step 13) *before* the watchdog existed at all — either gap reproduces the exact runaway-billing incident this feature exists to prevent. Steps re-sequenced so the watchdog is deployed and verified before any live/dedicated RunPod resource is provisioned.
- **Corrected a false claim about existing infrastructure.** The spec asserted `RUNPOD_API_KEY` would be "injected the same way `ORACLE_API_KEY`/`VISION_API_KEY` already are" — no such automated mechanism exists; `deploy-remote.sh` explicitly excludes `.env` from every sync. Now stated honestly as a manual SSH edit, with the correct file path (`/home/estate-scraper/estate-scraper/api/.env`, not `~/.env` — the original Test field grepped the wrong file).
- **Replaced an invented, fragile mechanism with the real proven one.** The watchdog was specified to use a persistent `/tmp` counter file across separate 15-min timer firings — a design that doesn't match, and is more fragile than, the actual working algo-corpus precedent (a single-execution inline recheck: poll, sleep, recheck once, act). Also fixed: the real precedent silently treats a GraphQL auth/error response the same as "no pods found" — this cutover's watchdog now fails loud instead.
- **Renamed a metric that collided with an existing term.** This feature's "recall@K" (a full-set backend-agreement rate, no K/cutoff involved) shares a name with ADR-0010's own different top-K ranking metric — renamed to "backend agreement rate" to avoid future confusion, and added a fixed-size item-level spot-check since the shared boolean-only `hasFindings()` scorer was tuned against Gemini's phrasing and may misjudge Qwen-VL's different style independent of real quality.
- **Added a required human go/no-go checkpoint** between calibration and production wiring — the original sequence had no explicit gate preventing an automatic walk from "calibration ran" straight into "production now points at RunPod."

## Critiques rejected
- SQL CHECK/NOT NULL constraint on `vlm_model` — this schema has no CHECK constraints anywhere else, and Gemini rows already rely on the same app-only invariant; adding one here would be inconsistent, not safer.
- Path-traversal validation on `calibrate-runpod.ts`'s CLI args — it's a local, operator-invoked dev tool, not a network-facing service; not a real threat surface.
- Redacting pod IDs from ntfy alerts — pod IDs are non-secret identifiers; not worth the engineering effort.
- API key visible via `ps`/bash history when passed as a RunPod GraphQL `?api_key=` query param — this is RunPod's own documented auth mechanism for that API, not a bug in this design; noted as an accepted platform-level risk rather than something this spec can fix.

## Open questions requiring human input
- Whether `runpod-workers/worker-vllm` actually serves the exact `Qwen3-VL-32B-Instruct` checkpoint (the research was grounded in Qwen2.5-VL forum threads) is unverified — the spec now includes an early feasibility spike to answer this before further build-out, with a fallback-model decision point if it fails.
- The final recall/agreement-rate threshold that makes RunPod "good enough" to become the production default is deliberately left as an operator decision from the calibration curve (matching how ADR-0010 already treats the Tier-1 budget dial) — not a number this spec sets.
