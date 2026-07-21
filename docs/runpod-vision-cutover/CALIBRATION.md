# Calibration Procedure — RunPod Vision Cutover

Operator runbook for calibrating a candidate RunPod-hosted vision backend against the frozen ADR-0010 Gemini reference pass before it is trusted as the Tier-2 production default. Follow the sections in order; do not skip the feasibility spike or the item-level spot-check.

## Prerequisites

- [ ] A RunPod account with an API key set as `RUNPOD_API_KEY` (`~/keys/runpod.rtf` on the Mac is the existing convention — reuse it, don't provision a new key).
- [ ] If the candidate deployment mode is a **dedicated pod** (not serverless): the watchdog (`scripts/runpod_vision_watchdog.sh` + its systemd timer) is already deployed on the desktop and its idle-detection/`podStop` path has been smoke-tested. **Do not provision a dedicated pod before this is true** — a dedicated pod billed with nothing watching it is the exact runaway-billing incident this cutover exists to prevent. Serverless mode has no such prerequisite (it scales to zero on its own).
- [ ] A frozen ADR-0010 reference-pass baseline JSON on hand. If one doesn't already exist, generate it first: `npm run scan -- --reference <path>` against the current Gemini backend (`VISION_API_BASE` pointed at Gemini). This is the `--baseline` file every candidate is compared against — do not regenerate it per candidate.

## Provisioning the RunPod endpoint

Run the **feasibility spike before building anything else** (watchdog, systemd units, calibration script are all built once, not per attempt) — the spike exists purely to confirm the intended serving stack loads the intended model at all before further work depends on it.

1. [ ] Stand up one endpoint, smallest viable config, serverless mode first (dedicated pod is the calibrated fallback only if serverless throughput calibrates poorly — see Interpreting the results).
2. [ ] GPU class: 48GB-class — L40 / L40S / RTX 6000 Ada for serverless, A40 (~$0.44/hr) as the cheap anchor if falling back to a dedicated pod. This is the sizing baseline for a 30B-class Qwen-VL model plus its image-token KV cache; do not reuse a text-model sizing config (image tokens inflate the KV cache well beyond a text-only model of the same parameter count and can OOM mid-batch or silently truncate context).
3. [ ] Template: `runpod-workers/worker-vllm` (RunPod's own official serverless vLLM image).
4. [ ] Model checkpoint: **Qwen3-VL-32B-Instruct** (already the model this repo's README/`.env.example` document for this slot). If `worker-vllm` fails to load or serve this exact checkpoint, fall back in this order and **record which substitution was made and why in `calibration-results.md` before any further calibration work proceeds**:
   - (a) Qwen2.5-VL-32B/72B — the checkpoint family the research backing this plan was actually validated against.
   - (b) another vLLM-supported vision-instruct checkpoint of comparable size.
5. [ ] Key vLLM launch flags:
   - `--limit-mm-per-prompt image=1` — `processImage` sends exactly one image per chat completion call, never a multi-image batch; set to the minimum both because vLLM requires an explicit limit and to keep the KV-cache footprint small.
   - `--gpu-memory-utilization` — tune down from a text-model default; vision KV cache is larger than a text-only model at the same parameter count.
   - `--max-model-len` — size for the image-token-inflated context, not a text-only baseline.
6. [ ] Reasoning-mode smoke test — **do this before running any full calibration pass**. Qwen3-VL is a reasoning-tuned model family that spends its token budget on chain-of-thought before answering; this exact bug already hit the local gate path (`LOCAL_GATE_MAX_TOKENS`'s comment in `api/src/lib/vision.ts`) and returned empty `content` on every call until fixed with `/no_think` + a larger `num_predict`. `runVisionManaged`/`VISION_SYSTEM_PROMPT` — the path this cutover routes Tier 2 through — carry no such guard today. Send a handful of test images through the candidate endpoint and confirm:
   - [ ] `content` is non-empty on every response.
   - [ ] `content` is not truncated mid-thought (i.e. doesn't cut off inside a `<think>` block or reasoning trace).
   - If the bug reproduces, it is **in scope to fix now, not defer** — apply whichever of these actually works against this serving stack, in order of preference: a `/no_think`-equivalent prefix on `VISION_SYSTEM_PROMPT`; vLLM's `chat_template_kwargs: {"enable_thinking": false}` request parameter if `worker-vllm` exposes it for this checkpoint; or `<think>...</think>` tag stripping in `runVisionManaged`'s response parsing before content reaches `hasFindings()`.

## Running the reference-pass scan

Point the app's env vars at the candidate RunPod endpoint, then run the same `--reference` code path used to produce the baseline:

```
npm run scan -- --reference <path>
```

**`.env` must actually be sourced into the shell first.** This codebase has no `dotenv` auto-loading anywhere — the only place env vars get loaded is `run-scan.sh`'s explicit:

```
set -a; source .env; set +a
```

A one-off calibration command run by hand from an SSH session does not get this for free. If you forget to export/source the candidate's temporary `VISION_API_BASE`/`VISION_API_KEY`/`VISION_API_MODEL` into the current shell, `VISION_API_BASE` reads as unset, `runVisionManaged` never fires, and the scan **silently falls through to the local Ollama model** — producing a "candidate" JSON file that is actually a mislabeled Ollama run, with no error raised. Mirror `run-scan.sh`'s pattern exactly (`set -a; source .env; set +a`, or an explicit `export` of each var) before invoking the command above — don't just set the vars inline on the same line as the command and assume it's equivalent for a multi-step session.

Every record in the resulting reference-pass JSON carries a `backend` field populated from `activeVlmModel()`. Before trusting the candidate file, confirm every record's `backend` actually names the intended RunPod model string — this is the concrete check that catches the silent-Ollama-fallback failure above after the fact, in case the sourcing step was still missed.

## Running the calibration script

```
npm run calibrate:runpod -- --baseline <path> --candidate <path> --elapsed-s <seconds>
```

- `--baseline` — the frozen Gemini reference-pass JSON.
- `--candidate` — the RunPod reference-pass JSON produced by the previous step, over the same or a representative (fixed, reproducible) subset of sales — not a full reference re-run per candidate.
- `--elapsed-s` — wall-clock seconds for the candidate run, measured by the operator. This is supplied manually rather than summed from per-image durations, because summing overstates true wall-clock time under `VISION_WORKERS` concurrency.

## Interpreting the results

The script reports:

- **Backend agreement rate** — `matched-hasFindings / baseline-hasFindings`, the fraction of the baseline's flagged images the candidate also flags. This is deliberately **not called "recall@K"** — ADR-0010 already uses that name for a different metric (Tier 1's top-K ranking-cutoff recall against the frozen reference pass). This feature's metric has no K/cutoff; it's a full-set agreement rate between two backends over the same image set. Don't conflate the two names when reading either doc.
- **Per-image latency, p50/p95** — computed over all images **except the first**.
- **Cold-start latency** — the first image's `durationS` alone, reported **separately** from the steady-state p50/p95, never blended into the average. A serverless 32B-class vision model likely has non-trivial cold-start time that a blended average would hide.
- **Throughput** — derived from the operator-supplied `--elapsed-s`, not summed per-image durations (see above). Compare against the weekly Scan's time budget — RunPod serverless vision throughput is an open, unproven problem in the vLLM community (the same failure shape as algo-corpus's ~6 chunks/min serverless bottleneck on a text model), so a slow throughput reading here is itself an actionable calibration result, not noise.

**Before trusting the backend agreement rate number alone**, do the required item-level spot-check: manually read, side-by-side, the **first 30 disagreements** between baseline and candidate `hasFindings` (or all disagreements if fewer than 30). For each one, judge whether the candidate is actually wrong, or whether the shared `hasFindings()` scorer — its junk-line detection, verbose-prefix rejection, and 1400-char cap — is misjudging Qwen-VL's different phrasing style rather than a real quality difference, since `hasFindings()` was tuned against Gemini's response conventions. 30 is fixed in advance: small enough to review in one sitting, large enough to catch a systematic heuristic mismatch rather than one-off noise. A spot-check by eye with no defined sample size does not satisfy this step — it is 30 (or all, if fewer), reviewed **before** the agreement-rate figure is recorded as final, not after.

If the candidate model reproduces the reasoning-mode empty-response bug (see Provisioning), a false "0 findings" reading here would look like a quality regression rather than the same known bug recurring at a new call site — rule this out before reading agreement rate as a genuine result.

## Recording the decision

Write the full result set — backend agreement rate, per-image latency (steady-state p50/p95 and cold-start, reported separately), throughput, the 30-item spot-check outcome, and whichever checkpoint/deployment-mode combination was actually calibrated (including any feasibility-spike substitution) — to `docs/runpod-vision-cutover/calibration-results.md`.

Before RunPod is wired into the desktop's production `api/.env` — the point of no return for the cutover — **explicitly record a go/no-go decision** based on these results in `calibration-results.md`. This is not an automatic or unattended step; a passing number alone does not constitute the decision.

If calibration is abandoned or fails before a decision is reached and a dedicated pod was provisioned during the attempt, explicitly `podStop` (or `podTerminate`) it by hand before walking away — do not leave a dedicated pod running "to come back to later" with nothing watching it, whether or not the watchdog is deployed yet.
