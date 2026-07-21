# Requirements: RunPod Vision Cutover

## Problem statement

The Tier-2 strong-VLM step of the vision pipeline (ADR-0010) currently runs against Google Gemini through `VISION_API_BASE`. The operator wants to replace Gemini with a self-hosted, RunPod-served open vision model for that same tier, for cost and control reasons — `api/src/lib/vision.ts` already accepts any OpenAI-compatible endpoint via env vars, so no plumbing work is required. The risk is not wiring the endpoint; it is that RunPod dedicated pods have no built-in idle-timeout and bill by the hour indefinitely once left running (already observed as a real cost incident in the sibling algo-corpus project), and that RunPod *serverless* throughput for vision models is an open, unresolved problem in the vLLM community (mirroring the ~6 chunks/min serverless bottleneck algo-corpus hit for its LLM extraction cascade). Standing up the endpoint without (a) a cost-safety mechanism and (b) a real calibration against the existing Gemini-based reference pass would let "wired up" pass for "working" on a pipeline whose whole design (ADR-0010) depends on cheap, reliable throughput.

## Users / stakeholders

- The operator (owner of the estate-scraper deployment) — pays the RunPod bill, sets the Tier-2 budget dial, and decides when RunPod is trusted as the production backend.
- The weekly Scan process — the only caller of the Tier-2 vision backend; its reliability and runtime are directly affected by backend choice.
- Downstream Findings/Items consumers (Hunt matching, Discover page, the taste ranker) — depend on Tier-2 output quality staying at parity with the Gemini baseline; a quality regression here propagates into every consumer.
- Future corpus/backfill jobs and prompt-eval work (`api/eval`) — read `vlm_model`/`prompt_version` provenance (ADR-0016) to know which rows came from which backend.

## Functional requirements

1. The system shall run the Tier-2 strong-VLM pass against a RunPod-hosted OpenAI-compatible endpoint by setting `VISION_API_BASE`, `VISION_API_KEY`, and `VISION_API_MODEL` in the desktop's production `api/.env`, with no code changes to `api/src/lib/vision.ts` or `api/src/vision/index.ts`.
2. The system shall stamp every Finding and Item produced via the RunPod backend with `vlm_model` equal to the configured `VISION_API_MODEL` value and the current `PROMPT_VERSION`, per ADR-0016, so RunPod-origin rows remain distinguishable from Gemini-origin rows already in the corpus.
3. The watchdog shall determine whether the vision workload is active by reading `api/data/scan-state.json` and checking whether its `phase` field equals `"analyzing"` — the actual GPU-billing phase — rather than the coarser `running` boolean, since `running` stays true during Tier 0 (scraping) and Tier 1 (CPU/CLIP ranking) while the RunPod pod sits completely idle and bills for nothing; the watchdog shall call RunPod's GraphQL `podStop` mutation once `phase` is confirmed not `"analyzing"`, so a pod never keeps billing after the Scan that needed it has finished.
4. The watchdog shall require two consecutive idle polls, separated by a cooldown interval of 5 minutes, before issuing `podStop`, so a transient dip between per-sale image batches does not trigger a premature stop mid-Scan.
5. The watchdog shall run on its own recurring schedule (e.g. a systemd timer under the estate-scraper service user, mirroring the algo-corpus precedent) independent of when a Scan starts or ends, so a pod left running by a failed or aborted Scan is still caught.
6. The watchdog shall also treat a Scan as idle if `scan-state.json`'s `phase`/`running` fields have not reset within a configurable maximum staleness duration, covering a stuck or crashed Scan (e.g. SIGKILL, OOM, or reboot) where the state file is never updated to reflect completion, so a non-graceful crash does not wedge a pod running indefinitely.
7. On a RunPod GraphQL error (from the `podStop` call or any status query) or an unreadable/malformed `scan-state.json`, the watchdog shall fail loud — raising an alert rather than silently logging and continuing — distinguishing "genuinely idle" from "can't tell if it's idle," since treating an error response the same as a confirmed-idle state would recreate the exact runaway-billing failure this watchdog exists to prevent.
8. The watchdog's pod-matching logic shall require an exact or strictly-scoped match on pod name/ID rather than a loose substring match, so that a pod belonging to the sibling algo-corpus project — which shares the same `RUNPOD_API_KEY`/account — cannot be collided with or mistakenly matched as this project's pod.
9. Before RunPod is treated as the production Tier-2 backend, the system shall calibrate it against the existing frozen ADR-0010 reference pass: run the RunPod backend over the reference image set or a representative sample — where "representative" means a fixed, reproducible selection defined in advance (e.g. a deterministic subset by ID or seed), not an arbitrary or convenience subset — and compute recall@K, the fraction of the reference pass's findings the RunPod backend reproduces, using the same methodology ADR-0010 already prescribes for Tier-1 calibration.
10. The calibration run shall record measured recall@K, per-image latency, and total wall-clock throughput for the RunPod backend, so a serverless-throughput regression (as already observed for the sibling project's LLM cascade, and flagged as an open problem for vision models in the vLLM community) is caught before cutover rather than discovered mid-Scan.
11. The calibration shall also include an item-level spot-check, on a defined sample size, comparing the specific items identified per image rather than only the has-findings boolean — using a distinct metric named "backend agreement rate" (not "recall@K," which ADR-0010 already uses for a different, top-K ranking metric) — so two backends flagging the same images while identifying completely different or wrong items is detected rather than masked by a boolean-only comparison.
12. Because `api/src/lib/vision.ts` documents that Qwen3-VL requires a chain-of-thought suppression fix (`/no_think` or equivalent) to avoid emitting empty responses on the local gate path, and `runVisionManaged`'s RunPod code path currently has none of that fix applied, the calibration shall verify whether the same reasoning-mode issue affects `runVisionManaged`'s use of the model, and the fix shall be applied to that path if so.
13. The system shall support both RunPod deployment modes (serverless endpoint URL vs. dedicated-pod proxy URL) purely through the value of `VISION_API_BASE`, requiring no application code branching, so the deployment mode selected by calibration results can be applied with an env change alone — verified by code review confirming no `if`/`else` (or equivalent) branching on deployment mode in `vision.ts`, rather than by running both modes live for every change, since running both live for every change would be costly.
14. On a RunPod endpoint error (non-2xx response, timeout, or pod not running), the system shall record the error on that image's result and continue processing the rest of the Scan rather than aborting it, matching the existing `runVisionManaged`/`processImage` catch behavior.
15. The system shall leave the free local Ollama PASS/SKIP gate (`LOCAL_GATE_ENABLED`) unaffected by this cutover — the change applies only to the Tier-2 strong-VLM backend, never to the local pre-filter gate.
16. The system shall keep the Gemini `VISION_API_BASE`/`VISION_API_MODEL` example documented in `api/.env.example` alongside the RunPod example, so reverting the backend is a one-line env change and restart, not a code change.
17. The system shall source the RunPod API key from the existing `RUNPOD_API_KEY` convention (`~/keys/runpod.rtf` on the Mac). No automated injection mechanism for managed-API keys exists anywhere in the repo — `scripts/deploy-remote.sh` explicitly excludes `.env` from every sync — so the key shall be set by directly editing the desktop's `api/.env` over SSH (`ssh desktop-agent`), the same manual mechanism already used for `VISION_API_KEY`/`ORACLE_API_KEY`, never hardcoded or committed to the repo.
18. Before RunPod is wired into the desktop production `api/.env` — the point of no return for the cutover — the operator shall explicitly record a go/no-go decision based on the calibration results; this shall not be an automatic or unattended step.

## Non-functional requirements

- Cost: total Tier-2 spend stays within the operator-set budget already established by ADR-0010 (~$5/mo target); the watchdog is the enforcement mechanism specifically against RunPod dedicated-pod runaway billing, since those pods have no built-in idle-timeout (unlike serverless, which scales to zero on its own).
- Reliability: a RunPod backend failure degrades to per-image errors, never a failed/aborted Scan (existing fail-open contract in `processImage` must hold for the new backend too).
- Provenance: 100% of Findings/Items produced via the RunPod backend carry a non-null `vlm_model` and `prompt_version` — no unstamped rows (ADR-0016 requirement, not new, but must hold across the swap).
- Security: `RUNPOD_API_KEY` and any RunPod endpoint credentials are never logged, never committed, and never present in `api/.env.example` (placeholders only).
- No corpus migration: because the VLM is explicitly not frozen (ADR-0016), swapping to RunPod requires no re-processing of existing rows — only new Scans use the new backend.

## Constraints

- Must conform to the existing OpenAI-compatible request/response contract already implemented in `runVisionManaged` (`/chat/completions`, `image_url` content block, `choices[0].message.content`) — no new wire format.
- Must not change Tier 0 (pHash dedup + quality gate) or Tier 1 (CLIP/SigLIP embedding ranker) — this cutover is scoped to Tier 2 only.
- Must not touch the embedding model or trigger a corpus migration (ADR-0016 draws that line explicitly around embeddings, not VLM choice).
- Must reuse the existing `RUNPOD_API_KEY` credential convention (`~/keys/runpod.rtf` on the Mac, env-injected on the desktop) rather than provisioning a new key.
- Must run in production on the desktop via the estate-scraper service user (`ssh desktop-agent`) — the Mac checkout is dev-only and does not run real Scans.
- Watchdog implementation should follow the proven algo-corpus pattern (`scripts/runpod_ingest_watchdog.sh`: poll job-queue state, confirm idle twice, call `podStop` via RunPod GraphQL) rather than inventing a new stop mechanism.
- Calibration must use the existing `api/eval` harness and/or the frozen ADR-0010 reference pass as the comparison substrate — not a new labeled set built from scratch.

## Out of scope

- Choosing or mandating a specific RunPod GPU type, model size/quantization, or vLLM serving flags — these are implementation details resolved during calibration, not requirements of this document.
- Any change to Tier 0 or Tier 1 of the vision cascade.
- Any change to the embedding model, thumbnail persistence, or a corpus re-embed migration.
- The Oracle escalation tier (`ORACLE_API_BASE`/`ORACLE_MODEL`) — a separate config surface, unaffected by this cutover.
- Building a general-purpose RunPod pod scheduler or autoscaler — only the single stop-on-idle watchdog described above.
- UI changes to surface backend/model choice to end users of the Discover/Hunt dashboard.
- Setting a specific numeric recall@K pass/fail bar — this document specifies the calibration methodology; the actual acceptance bar is an operator decision from the resulting recall@K curve, exactly as ADR-0010 already treats the Tier-1 budget dial.

## Acceptance criteria

1. With `VISION_API_BASE`/`VISION_API_KEY`/`VISION_API_MODEL` pointed at a RunPod endpoint, a Scan run against a test batch produces Findings/Items whose `vlm_model` column equals the configured RunPod model string, verified by querying the database after the run.
2. Reverting `VISION_API_BASE`/`VISION_API_MODEL` to the Gemini values (or unsetting `VISION_API_BASE` entirely) restores prior behavior with only an env change and service restart — no code deploy required.
3. Both RunPod deployment modes (serverless endpoint URL and dedicated-pod proxy URL) are confirmed to work through `VISION_API_BASE` alone, verified by code review confirming no `if`/`else` (or equivalent) branching on deployment mode in `api/src/lib/vision.ts` — not by running both modes live.
4. A calibration run comparing RunPod-backend output against the frozen ADR-0010 reference pass produces a written recall@K figure and a per-image latency figure, on record before any switch of the production default backend.
5. With no Scan running (`scan-state.json`'s `phase` not `"analyzing"`), simulating an idle vision job queue causes the watchdog to call `podStop` only after two consecutive idle polls separated by the 5-minute cooldown interval — verified via watchdog logs and the pod's `desiredStatus` transitioning from `RUNNING` to `STOPPED`.
6. Simulating a single idle poll followed by renewed activity (a transient mid-Scan dip) does not trigger `podStop` — no stop call is logged.
7. Forcing a RunPod endpoint failure (e.g. an invalid endpoint ID or unreachable pod) results in per-image error results in the Scan output and a completed (not aborted) Scan run.
8. A pod left `RUNNING` with no Scan activity for longer than the watchdog's full poll-and-confirm window is stopped automatically with no manual intervention. A simulated/mocked idle state is the required and sufficient verification for this criterion; a real extended-idle GPU test is optional and not required, since it would only re-prove logic already covered by simulation at real cost.
9. `api/.env.example` documents both the Gemini and RunPod `VISION_API_BASE` examples, and a repo-wide credential scan — grepping git history and all tracked files, not just `.env.example` — finds no committed value for `RUNPOD_API_KEY`.
10. The local PASS/SKIP gate (`LOCAL_GATE_ENABLED`) continues to function and is unaffected by any `VISION_API_BASE`/`VISION_API_MODEL` change, verified by running a Scan with the gate enabled against the RunPod backend.
