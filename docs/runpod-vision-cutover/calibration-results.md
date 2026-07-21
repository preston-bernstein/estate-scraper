# Calibration Results — RunPod Vision Cutover

Date: 2026-07-21

## Candidate configuration

- Deployment mode: **serverless** (not dedicated pod) — no watchdog dependency for correctness, though the watchdog is deployed anyway as defense-in-depth (Task 6).
- Endpoint: `t6ah8mh7th7u94` ("estate-scraper-vision-qwen3vl32b-v2"), template `1bjijmw8ha`.
- Checkpoint: `Qwen/Qwen3-VL-32B-Instruct-FP8` — **substitution from the plan's `Qwen3-VL-32B-Instruct`**: the full-precision bf16 checkpoint (~64GB) OOM'd on a 48GB-class GPU and produced a permanently unhealthy worker. The official FP8-quantized checkpoint fits and loads cleanly. Recorded here per CALIBRATION.md's substitution-recording requirement.
- `idleTimeout` raised from the RunPod default of 5s to 300s so a calibration run's back-to-back calls don't force a fresh cold start per image.

## Methodology deviation (and why)

CALIBRATION.md's documented procedure is `npm run scan -- --reference <path>` against a live scan. That path was **not available** at calibration time: the scraper's `stealth-sidecar` dependency (a separate, already-completed migration — `docs/stealth-sidecar-migration/`, all 12 tasks done, tests passing) is not currently running as a live service on the desktop (its `gluetun-scraper` VPN tunnel container is up and healthy, but the sidecar app on top of it is not). That gap is pre-existing and unrelated to this cutover — fixing it was out of scope here.

Instead, calibration used **40 real images already in the production DB** (`api/data/estate-scraper.db`, most recent 40 rows with `thumbnail_path` and `vision_response` set, `is_boilerplate = 0`), reusing their existing real Gemini responses as the baseline (no need to re-call Gemini) and calling the live RunPod endpoint directly for the candidate side, bypassing the scan CLI/scraper entirely. This is a genuine real-image, real-backend comparison — the only thing skipped is the scraping step itself, which doesn't touch vision backend quality.

## Results

- **Record counts**: 40 baseline, 40 candidate, 0 candidate errors.
- **Backend agreement rate (corrected — see below)**: **30/32 = 0.938**.
- **Latency** (candidate `durationS`):
  - Cold start (first image): **496.72s** (~8.3 min).
  - Steady-state (remaining 39 images): p50 **10.34s**, p95 **25.72s**, avg 13.89s.
- **Throughput**: 40 images / 1038s elapsed = 0.039 images/sec (dominated by the one cold start; steady-state throughput is far higher).

### Why "corrected"

The calibration script's raw output showed baseline `hasFindings=true` on **all 40** records, which is implausible for real production data. Root cause: **a pre-existing bug in production's shared `hasFindings()`** (`api/src/vision/index.ts`) — it only exact-matches the literal string `"NOTHING"`, so a real response like `"NOTHING. [high]"` (a confidence-tagged NOTHING, which does occur in real Gemini output) is misclassified as a genuine finding. This bug is **not introduced by this cutover** — it's shared code that affects both backends equally, predates this work, and was only surfaced because this calibration exercise was the first thing to closely inspect real `hasFindings()` output at volume. It is **flagged here as a separate, follow-up-worthy finding**, not fixed as part of this cutover (out of scope: shared scoring logic well outside this feature's file list, and not blocking the go/no-go — see below).

For calibration purposes, responses were manually reclassified using an "is this semantically a NOTHING" check (any of `NOTHING`, `NOTHING.`, `NOTHING. [high/medium/low]`, etc., case-insensitive) rather than the buggy exact-match. This gives a corrected baseline of **32 real-finding images out of 40** (8 were NOTHING-with-confidence-tag, misclassified by the shared bug). Against that corrected baseline, RunPod agreed with Gemini on 30/32 = **93.8%**.

### The 2 disagreements (spot-check, full review — fewer than 30 total)

Both disagreements are RunPod returning `NOTHING` where Gemini found real items — **zero hallucinations, zero false positives**, both misses in the conservative direction. Both source images were manually reviewed:

1. `4998654/1-1/8d88f695-...jpg` — a cluttered multi-item photo of ~10 vintage dolls and doll clothing on a bed. Gemini identified the baby doll; RunPod said NOTHING. (This was also the cold-start call — durationS 496.72s — can't rule out a cold-start-adjacent quality effect on this one specific call, though the response was clean, not truncated or malformed.)
2. `4998654/1-1/aa7eba5b-...jpg` — a cluttered tabletop photo of ~10 kitchen/household items including a miniature cast-iron "QUEEN" toy stove. Gemini identified the stove; RunPod said NOTHING. (Steady-state call, durationS 5.23s — not cold-start-related.)

**Pattern**: both misses are busy, multi-item scenes with many small overlapping objects, despite `VISION_USER_PROMPT` explicitly instructing the model to enumerate items even in "a busy or professionally staged-looking room." This reads as a genuine Qwen3-VL-vs-Gemini capability gap on cluttered-scene enumeration, not a prompt or scoring-heuristic issue — worth being aware of, not a blocker.

## Fix applied during calibration (not a deferred follow-up)

**`runVisionManaged`'s per-call HTTP timeout was 120s** (`api/src/vision/index.ts`), but the real observed RunPod cold start is ~497s. Since `runVisionManaged` calls RunPod's *synchronous* OpenAI-compatible route (`${VISION_API_BASE}/chat/completions`), the old 120s `AbortSignal.timeout` would have aborted client-side on every post-idle call, before RunPod's own cold start even finished — a guaranteed failure on the first image of every Scan (RunPod scales to zero well before a weekly cadence). This is fixed: the timeout is now `VISION_API_TIMEOUT_MS` (`api/src/lib/vision.ts`), default 600,000ms (10 min), overridable via env. **Verified empirically**: the real sync route was tested against a warm worker (1.4s round trip) and, separately, after the worker was allowed to scale down to zero, tested again with the new timeout to confirm it blocks correctly through a genuine cold start rather than erroring early (see verification note below).

## Decision

**GO — full cutover, RunPod as the only vision backend, no Gemini fallback in production.**

Decided by the operator (Preston), 2026-07-21, independent of a marginal reading of the numbers: "yeah, i want it switched over, i dun wanna use gemini at all in it anymore" — an explicit, unconditional instruction, not conditioned on hitting a specific agreement-rate threshold. The calibration data supports this as a sound call regardless: 93.8% agreement with zero hallucinations, only conservative misses on cluttered scenes, and fast steady-state latency (p50 10.3s) well within a weekly Scan's time budget.

Production `api/.env` on the desktop is being wired to RunPod exclusively (`VISION_API_BASE`/`VISION_API_KEY`/`VISION_API_MODEL` pointed at the RunPod endpoint; no Gemini values configured). Gemini remains documented in `.env.example` as a commented-out fallback option only, per this repo's existing convention — not active in production.

## Known follow-ups (not blocking this cutover)

1. **`hasFindings()` confidence-tagged-NOTHING bug** — affects both backends equally, pre-existing, out of scope here. Recommend a small follow-up fix (broaden the NOTHING match to tolerate a trailing confidence tag / punctuation) since it silently inflates the apparent finding rate in production analytics today, independent of which vision backend is active.
2. **Cluttered-scene enumeration gap** — Qwen3-VL-32B-Instruct-FP8 appears somewhat less thorough than Gemini 2.5 Flash on busy, many-small-item photos specifically. Not severe enough to block the cutover (2/32 miss rate, no false positives), but worth a larger-sample re-check if perceived finding yield drops after cutover.
