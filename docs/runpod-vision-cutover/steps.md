# Steps: RunPod Vision Cutover

## Prerequisites

1. RunPod account access with available GPU quota (48GB+ class, e.g. L40/L40S/RTX 6000 Ada for serverless, A40 for dedicated fallback).
2. RunPod API key provisioned at `~/keys/runpod.rtf` on the Mac (stored as a single line, injected into desktop's environment during deploy, same pattern as `ORACLE_API_KEY`).
3. Access to the desktop via `ssh desktop-agent` (service user, `~/.ssh/agent_ed25519` key).
4. Frozen ADR-0010 reference-pass baseline JSON available (or dataset known to run against existing Gemini backend for calibration).

## Implementation steps

### Step 1: Feasibility spike — confirm worker-vllm serves Qwen3-VL-32B-Instruct
**What**: Before investing in the rest of the build, confirm that the `runpod-workers/worker-vllm` serverless template actually serves the specific `Qwen3-VL-32B-Instruct` checkpoint (vLLM/worker-vllm support was verified against Qwen2.5-VL forum threads, not confirmed for this exact Qwen3-VL checkpoint). Spin up a minimal temporary serverless endpoint with the template pointed at the checkpoint and send one test completion. If it fails to load or serve, name a fallback model decision (e.g. drop to `Qwen2.5-VL-32B-Instruct` or another checkpoint already confirmed compatible with worker-vllm) before proceeding to any other step.
**Files**: none (external RunPod spike; no repo files)
**Test**: A single test chat completion against the spiked endpoint returns a valid, non-empty response using the `Qwen3-VL-32B-Instruct` checkpoint. If it fails, the fallback model name and rationale are recorded in the commit/PR description for this step, and all later steps referencing "the model" use the fallback instead.
**Depends on**: none
**Parallelizable**: Yes

### Step 2: Add RUNPOD_API_KEY placeholder + repo-wide secret scan
**What**: Document the `RUNPOD_API_KEY` environment variable in `api/.env.example` with a placeholder comment distinguishing it from the inference-wire `VISION_API_KEY`, and confirm via a repo-wide (not just `.env.example`) credential scan that no committed `RUNPOD_API_KEY` value exists anywhere in tracked files or git history — satisfying acceptance criterion 8 directly rather than assuming it.
**Files**: `api/.env.example`
**Test**: `grep -A2 "RUNPOD_API_KEY" api/.env.example` returns a placeholder (not a real key), with a comment explaining "RunPod management API key for watchdog podStop calls, distinct from VISION_API_KEY." Repo-wide scan: `git grep -n "RUNPOD_API_KEY"` across all tracked files shows only the placeholder line in `api/.env.example`; `git log --all -p -- . | grep -i "RUNPOD_API_KEY="` shows no committed non-placeholder value in history.
**Depends on**: none
**Parallelizable**: Yes

### Step 3a: Implement core watchdog logic (idle detection)
**What**: Write a bash watchdog that reads `api/data/scan-state.json`'s `phase` field — not the `running` boolean, which stays `true` for the whole Scan including the non-RunPod `scraping` phase — to determine whether RunPod is actually idle (`phase !== "analyzing"`). Mirror the algo-corpus script's proven single-execution confirm pattern exactly: read state once, and if idle, sleep an inline cooldown (~5 min), re-read state once more, and only then call RunPod's GraphQL `podStop` mutation on a `RUNNING` pod matching `RUNPOD_POD_NAME_MATCH` if still idle. No persistent `/tmp` counter file across invocations — the two-check confirmation happens within one script execution.
**Files**: `scripts/runpod_vision_watchdog.sh`, `api/.env.example` (document `RUNPOD_POD_NAME_MATCH`, default `estate-scraper-vision`)
**Test**: `bash -n scripts/runpod_vision_watchdog.sh` passes. Script logic confirmed to: (a) load `.env` for `RUNPOD_API_KEY`/`RUNPOD_POD_NAME_MATCH`, (b) read `api/data/scan-state.json` and treat idle as `phase != "analyzing"` (not the `running` boolean), (c) on idle, sleep ~5 min inline then re-read state once more before acting — `grep -n "/tmp" scripts/runpod_vision_watchdog.sh` returns no counter-file path, (d) on confirmed idle, query RunPod GraphQL for `RUNNING` pods whose name matches `RUNPOD_POD_NAME_MATCH` and call `podStop`, (e) log every decision to `runpod-watchdog.log`.
**Depends on**: none
**Parallelizable**: Yes

### Step 3b: Implement watchdog staleness/crash guard
**What**: Extend the watchdog with a staleness guard: if `phase` is `analyzing` (Scan still nominally active) but `startedAt` is older than `WATCHDOG_MAX_SCAN_HOURS`, treat the pod as idle and stop it regardless of phase — catching a Scan process that died without calling `writer.finish()` (SIGKILL, OOM, host reboot). Validate `WATCHDOG_MAX_SCAN_HOURS` at startup: fail loud (non-zero exit, logged error, optional `NTFY_URL` alert) if the value is missing or not a positive integer, rather than silently falling back to a default.
**Files**: `scripts/runpod_vision_watchdog.sh`, `api/.env.example` (document `WATCHDOG_MAX_SCAN_HOURS`, default 6)
**Test**: `bash -n` passes. Run with `WATCHDOG_MAX_SCAN_HOURS` unset → script exits non-zero with a logged error (not a silent default). Run with `WATCHDOG_MAX_SCAN_HOURS=abc` (non-integer) → same fail-loud behavior. Run with `WATCHDOG_MAX_SCAN_HOURS=6` and a mock `scan-state.json` with `phase: "analyzing"`, `startedAt` 12 hours ago → `podStop` is called due to staleness, independent of the idle-confirm path from Step 3a.
**Depends on**: Step 3a
**Parallelizable**: No

### Step 4: Create systemd service and timer units for watchdog
**What**: Create user-level systemd units (not system-level, to match estate-scraper's existing deployment convention) that run the watchdog script on a recurring schedule independent of Scan timing.
**Files**: `systemd/estate-scraper-runpod-watchdog.service`, `systemd/estate-scraper-runpod-watchdog.timer`
**Test**: `systemd-analyze verify systemd/estate-scraper-runpod-watchdog.{service,timer}` succeeds, timer is set to `OnCalendar=*:0/15` (every 15 minutes), `Persistent=true`, no `User=`/`Group=` fields (user-level units), `WantedBy=default.target`.
**Depends on**: Step 3a, Step 3b
**Parallelizable**: No

### Step 5a: Test watchdog — no stop while analyzing phase active
**What**: Verify the watchdog does not call `podStop` while a Scan is in the `analyzing` phase (RunPod actually in use).
**Files**: (temporary test files in scratchpad, not committed)
**Test**: Create mock `scan-state.json` with `phase: "analyzing"`, `running: true`, `startedAt` recent. Run the watchdog once against a stub RunPod GraphQL responder → no `podStop` call logged; `runpod-watchdog.log` shows an "active, skipping" line.
**Depends on**: Step 4
**Parallelizable**: Yes

### Step 5b: Test watchdog — stop after idle confirmed
**What**: Verify the inline two-check pattern correctly stops an idle pod within a single script execution.
**Files**: (temporary test files in scratchpad, not committed)
**Test**: Create mock `scan-state.json` with `phase: "idle"` (or `"done"`), `running: false`. Run the watchdog once → script sleeps ~5 min inline, re-reads, confirms still idle, `podStop` is logged, and the mock pod transitions from `RUNNING` to `STOPPED` in the stub responder.
**Depends on**: Step 4
**Parallelizable**: Yes

### Step 5c: Test watchdog — staleness guard forces stop on stuck scan
**What**: Verify a Scan stuck in `analyzing` for longer than `WATCHDOG_MAX_SCAN_HOURS` is stopped via the staleness path, not the idle-confirm path.
**Files**: (temporary test files in scratchpad, not committed)
**Test**: Mock `scan-state.json` with `phase: "analyzing"`, `startedAt` 12 hours ago, `WATCHDOG_MAX_SCAN_HOURS=6`. Run the watchdog once → `podStop` is called immediately; `runpod-watchdog.log` shows "staleness guard triggered," distinct from the idle-confirm log line used in Step 5b.
**Depends on**: Step 4
**Parallelizable**: Yes

### Step 5d: Test watchdog — cross-project pod collision
**What**: Verify the watchdog's `RUNPOD_POD_NAME_MATCH` substring match does not stop a pod belonging to the sibling algo-corpus project on the same RunPod account.
**Files**: (temporary test files in scratchpad, not committed)
**Test**: Stub the RunPod GraphQL responder to return two `RUNNING` pods: one named per `RUNPOD_POD_NAME_MATCH` (e.g. `estate-scraper-vision-xyz`) and one named like an algo-corpus pod (e.g. `algo-corpus-ingest-abc`). Trigger the idle-stop path → only the estate-scraper-named pod receives `podStop`; the algo-corpus-named pod is untouched, confirmed via the stub's call log.
**Depends on**: Step 4
**Parallelizable**: Yes

### Step 5e: Test watchdog — fail loud on GraphQL error
**What**: Verify the watchdog fails loudly, not silently, when the RunPod GraphQL call itself errors.
**Files**: (temporary test files in scratchpad, not committed)
**Test**: Stub the RunPod GraphQL responder to return a 4xx/5xx or malformed error body. Run the watchdog → an explicit error is logged to `runpod-watchdog.log` (and an `NTFY_URL` alert fires if configured), and the script exits non-zero — confirmed it does not exit 0 / log nothing on this path.
**Depends on**: Step 4
**Parallelizable**: Yes

### Step 6: Deploy watchdog systemd units to desktop
**What**: Copy the systemd service and timer files to the desktop's user systemd directory, enable the timer, and confirm the `estate-scraper` service user has lingering enabled so the user-level systemd instance runs the timer without an active login session. This step, fully verified, MUST complete before any dedicated-pod RunPod endpoint is provisioned (Step 13a) — a dedicated pod must never exist on RunPod without the auto-stop watchdog already protecting it.
**Files**: (deployed to `~/.local/share/systemd/user/` on desktop)
**Test**: `ssh desktop-agent "systemctl --user status estate-scraper-runpod-watchdog.timer"` shows the timer is active and next trigger time is within 15 minutes. `ssh desktop-agent "systemctl --user list-timers estate-scraper-runpod-watchdog.timer"` confirms it's scheduled. `ssh desktop-agent "loginctl show-user estate-scraper --property=Linger"` returns `Linger=yes`, confirming the timer fires without an active login session.
**Depends on**: Step 5a, Step 5b, Step 5c, Step 5d, Step 5e
**Parallelizable**: No

### Step 7: Add durationS field forwarding to reference-pass tracking
**What**: Modify the reference-pass event emission and `ReferenceRecord` data structure to include per-image latency (`durationS`), so the calibration script can compute latency stats from the reference JSON.
**Files**: `api/src/vision/index.ts`, `api/src/scan/index.ts`
**Test**: `npm run build` succeeds. Run `npm run scan -- --reference <path>` over a small test batch, inspect the output reference JSON → each record includes a `durationS` field with a positive number.
**Depends on**: none
**Parallelizable**: Yes

### Step 8: Add backend-provenance field to ReferenceRecord
**What**: Extend the `image_result` event and `ReferenceRecord` structure with a backend/model provenance field (e.g. `visionApiModel`, sourced from the same `activeVlmModel()`/`VISION_API_MODEL` value `persist.ts` already stamps onto DB rows), so a reference-pass JSON is self-describing about which backend produced it, independent of filename convention. This is the integration point Step 13b's candidate-data generation depends on, alongside `durationS`.
**Files**: `api/src/vision/index.ts`, `api/src/scan/index.ts`
**Test**: `npm run build` succeeds. Run `npm run scan -- --reference <path>` with `VISION_API_MODEL` set to a test value → every record in the output reference JSON includes the provenance field matching the configured value.
**Depends on**: none
**Parallelizable**: Yes

### Step 9: Implement calibrate-runpod.ts calibration script + register npm script
**What**: Write a TypeScript script that compares a RunPod-generated reference JSON against the Gemini baseline, matches records by `imageUrl`, computes recall@K (fraction of baseline's `hasFindings` cases the candidate also identifies), and outputs per-image latency percentiles and wall-clock throughput. Register the `calibrate:runpod` npm script as part of authoring it, not as a separate step.
**Files**: `api/eval/calibrate-runpod.ts`, `api/package.json`
**Test**: `tsx api/eval/calibrate-runpod.ts --help` shows usage; `npm run calibrate:runpod -- --help` shows the same usage via the registered script. Accepts `--baseline <path>` (Gemini reference JSON), `--candidate <path>` (RunPod reference JSON), `--elapsed-s <seconds>` (wall-clock time for candidate run). Output includes: recall@K figure (0.0–1.0), per-image latency p50/p95, throughput (images/second), and a summary table comparing baseline vs candidate.
**Depends on**: Step 7
**Parallelizable**: No

### Step 10: Test calibration script locally with mock reference JSONs
**What**: Verify the calibration script correctly parses reference JSONs, matches records, computes recall@K, and outputs latency/throughput figures.
**Files**: (temporary mock JSONs in scratchpad, not committed)
**Test**: Create mock Gemini reference JSON with 10 images, 7 flagged as `hasFindings: true`. Create mock RunPod reference JSON with same images, 6 flagged as `hasFindings: true` (one miss). Run `npm run calibrate:runpod -- --baseline <gemini-mock> --candidate <runpod-mock> --elapsed-s 120` → output shows recall@K = 6/7 ≈ 0.857, latency stats are computed, throughput ≈ 10 images / 120 seconds ≈ 0.083 images/sec.
**Depends on**: Step 9
**Parallelizable**: No

### Step 11: Write calibration procedure document
**What**: Document the step-by-step procedure for running a calibration pass: provisioning a RunPod endpoint with specified model/vLLM config, running `npm run scan -- --reference <path>` against it, and running `npm run calibrate:runpod` to compare against baseline.
**Files**: `docs/runpod-vision-cutover/CALIBRATION.md`
**Test**: The document contains, as a literal checklist (not a subjective judgment call), each of: (1) RunPod provisioning steps (GPU type, model, vLLM launch flags), (2) the exact scan command (`npm run scan -- --reference <path>`), (3) the exact calibration command (`npm run calibrate:runpod -- --baseline ... --candidate ... --elapsed-s ...`), (4) interpretation criteria for recall@K, latency percentiles, and throughput. `grep -c "^##" docs/runpod-vision-cutover/CALIBRATION.md` shows at least 4 sections matching this checklist.
**Depends on**: none
**Parallelizable**: Yes

### Step 12: Test RunPod endpoint error handling
**What**: Verify that invalid or unreachable RunPod endpoint configuration (connectivity failure, bad API key, pod not running) results in per-image error records in the reference output and a completed Scan run, matching the existing fail-open error contract. This only exercises the existing, pre-existing scan/vision plumbing (`runVisionManaged`/`processImage` already fail open) — it needs no calibrated endpoint and can run against any reachable-but-wrong endpoint, so it is done before any real GPU time is spent.
**Files**: (none — tests existing code paths)
**Test**: On the desktop, temporarily point `VISION_API_BASE` to an intentionally invalid/unreachable endpoint (e.g., `http://invalid-host:9999`, or a wrong pod ID, or a valid URL with an expired/bad `VISION_API_KEY`), run `npm run scan -- --reference <path>` over a small test batch (5–10 sales from the frozen reference set), verify: (a) reference JSON output file is created with records for all images tested, (b) each image record shows an error state (per-image error capture, not a Scan abort) — an error message field or null `hasFindings` with error reason, (c) the Scan process exits successfully (code 0) rather than aborting mid-stream, (d) a completed-log message is written, indicating graceful completion.
**Depends on**: none
**Parallelizable**: Yes

### Step 13a: Provision + smoke-test the RunPod endpoint
**What**: Provision a RunPod endpoint (serverless or dedicated pod, per `CALIBRATION.md`) via the `worker-vllm` template serving the checkpoint confirmed in Step 1, and verify a single test chat completion succeeds against the OpenAI-compatible endpoint before spending real scan time. As part of the smoke test, send a prompt likely to trigger a long chain-of-thought response and confirm the response is not empty/truncated — this is the same Qwen3 reasoning-mode bug already hit and documented for the local gate (see the `LOCAL_GATE_MAX_TOKENS` comments in `api/src/lib/vision.ts`), and must be ruled out here, not discovered mid reference-pass. **If targeting dedicated-pod mode, Step 6's watchdog MUST already be deployed and verified** — do not provision a dedicated pod before that. If this endpoint is abandoned after this step without proceeding to Step 13b, it must be explicitly deprovisioned (`podTerminate`/stop via GraphQL or the RunPod console), not left running.
**Files**: none (external RunPod resource; no repo files)
**Test**: A single manual chat-completion request against the endpoint's `/chat/completions` returns a non-empty, non-truncated response within a reasonable token budget (mirroring the `LOCAL_GATE_MAX_TOKENS` fix — increase `max_tokens` if the response is empty/cut off mid-reasoning). If dedicated-pod mode: `ssh desktop-agent "systemctl --user status estate-scraper-runpod-watchdog.timer"` reconfirmed active immediately before provisioning. Endpoint ID/pod ID and mode are recorded for Step 13b.
**Depends on**: Step 1, Step 6 (mandatory if dedicated-pod mode; not required for a serverless-only smoke test)
**Parallelizable**: No

### Step 13b: Run the reference-pass scan against the endpoint
**What**: Point desktop's `VISION_API_BASE`/`VISION_API_KEY`/`VISION_API_MODEL` at the endpoint smoke-tested in Step 13a, and run `npm run scan -- --reference <path>` over the frozen ADR-0010 reference-pass sales (or a representative subset) to generate the candidate reference JSON.
**Files**: (produces reference JSON on desktop at operator-chosen path, e.g. `/tmp/runpod-reference.json`)
**Test**: Scan completes without aborting, reference JSON is written with `durationS` fields (Step 7) and the backend-provenance field (Step 8) on every record, file size and record count match the baseline or expected subset.
**Depends on**: Step 13a, Step 7, Step 8
**Parallelizable**: No

### Step 14: Record calibration results
**What**: Run the calibration script and document the measured recall@K, per-image latency (p50, p95), and wall-clock throughput.
**Files**: `docs/runpod-vision-cutover/calibration-results.md`
**Test**: File is created with sections: (a) recall@K figure with interpretation, (b) per-image latency p50/p95 with comparison to Gemini baseline, (c) throughput (images/second) with interpretation (serverless adequate or dedicated pod needed), (d) timestamp of calibration run.
**Depends on**: Step 13b, Step 10
**Parallelizable**: No

### Step 15: Operator go/no-go decision
**What**: The operator reviews the recorded calibration figures from Step 14 and makes an explicit go/no-go call on cutting Tier 2 over to RunPod, naming the selected deployment mode and model (or "no-go, remain on Gemini"). This is a distinct, explicit checkpoint — not implied by the results doc alone.
**Files**: `docs/runpod-vision-cutover/calibration-results.md` (decision section, appended)
**Test**: The file contains an explicit `Decision:` line stating go or no-go, the deployment mode/model chosen (if go), the rationale tied to the recall@K/latency/throughput figures from Step 14, and the date of the decision.
**Depends on**: Step 14
**Parallelizable**: No

### Step 16a: Update cross-reference docs — scaffold
**What**: Append a short addendum to ADR-0010 noting that Tier 2's backend is now configurable as Gemini (legacy) or RunPod (current) via environment variables, calibrated per this cutover's process (not frozen by the ADR). In the same pass, fix README's pre-existing doc drift: the Configuration table currently documents `RUNPOD_ENDPOINT_ID`/`RUNPOD_MODEL` env vars that don't exist anywhere in the actual code — replace them with the real `VISION_API_BASE`/`VISION_API_KEY`/`VISION_API_MODEL` vars, and add a placeholder pointer in the Calibration section to `calibration-results.md`.
**Files**: `docs/adr/0010-budget-bounded-runpod-cascade.md`, `README.md`
**Test**: `grep "environment variable" docs/adr/0010-budget-bounded-runpod-cascade.md` returns the addendum text. `grep -n "RUNPOD_ENDPOINT_ID\|RUNPOD_MODEL" README.md` returns nothing (drift removed). README's Configuration table lists `VISION_API_BASE`/`VISION_API_KEY`/`VISION_API_MODEL` instead. The Calibration section references `calibration-results.md`.
**Depends on**: none
**Parallelizable**: Yes

### Step 16b: Update cross-reference docs — fill in calibrated values
**What**: Update the Stack table's Tier 2 row and Configuration table with the calibrated model name and deployment mode selected by Step 15's go decision.
**Files**: `README.md`
**Test**: `grep -A2 "Tier 2" README.md` shows the actual calibrated RunPod model name and deployment mode (serverless or dedicated), matching Step 15's recorded decision.
**Depends on**: Step 15, Step 16a
**Parallelizable**: No

### Step 17: Wire production api/.env on desktop with calibrated RunPod values
**What**: SSH to desktop, update `api/.env` to set `VISION_API_BASE`/`VISION_API_KEY`/`VISION_API_MODEL` to the calibrated RunPod values (per Step 15's go decision), and add `RUNPOD_API_KEY` sourced from `~/keys/runpod.rtf` using the existing managed-key injection pattern.
**Files**: `/home/estate-scraper/estate-scraper/api/.env` on desktop (not repo-committed)
**Test**: `ssh desktop-agent "grep VISION_API_BASE /home/estate-scraper/estate-scraper/api/.env"` returns the RunPod endpoint URL, `grep RUNPOD_API_KEY /home/estate-scraper/estate-scraper/api/.env` returns a non-empty value (or verify it's set via the env-injection script if using that pattern), `grep VISION_API_MODEL /home/estate-scraper/estate-scraper/api/.env` returns the calibrated model name.
**Depends on**: Step 15
**Parallelizable**: No

### Step 18: Restart desktop service and verify first Scan
**What**: Restart the estate-scraper service on desktop, trigger or wait for the next scheduled Scan, and verify that the scan completes successfully and produces Finding/Item rows with `vlm_model` and `prompt_version` stamped correctly.
**Files**: none
**Test**: `ssh desktop-agent "systemctl --user restart estate-scraper"` completes without error. Next scan runs to completion. Query the database: `SELECT DISTINCT vlm_model, prompt_version FROM findings WHERE created_at > NOW() - INTERVAL 1 HOUR LIMIT 1;` returns the RunPod model name (e.g., `Qwen/Qwen3-VL-32B-Instruct`) and a non-null `prompt_version`, confirming both provenance fields are stamped on RunPod-origin rows. (Watchdog timer-firing behavior is already covered by Steps 5b/5c/6's own tests and is not re-tested here.)
**Depends on**: Step 6, Step 17
**Parallelizable**: No

## Rollback plan

**Code and doc changes (Steps 2, 3a, 3b, 4, 7, 8, 9, 11, 14, 15, 16a, 16b):** All reversible via `git checkout` or `git reset`. Revert to the previous commit to undo. (Steps 5a–5e, 10, 12, and 13a/13b touch no committed repo files — nothing to revert there.)

**Desktop watchdog systemd deployment (Step 6):** SSH to desktop and run:
```bash
systemctl --user disable --now estate-scraper-runpod-watchdog.timer
systemctl --user disable --now estate-scraper-runpod-watchdog.service
rm ~/.local/share/systemd/user/estate-scraper-runpod-watchdog.*
systemctl --user daemon-reload
```

**Abandoned or failed RunPod calibration endpoint (Steps 13a/13b):** If a serverless endpoint or dedicated pod provisioned for calibration is no longer needed — whether the calibration finished, was abandoned mid-way, or failed the Step 13a smoke test — explicitly deprovision it rather than leaving it running: call RunPod's GraphQL `podTerminate`/`podStop` mutation for the pod ID, or terminate/stop it from the RunPod console directly. A dedicated pod left running with no watchdog attached (e.g. one provisioned only for a quick smoke test, never wired into the watchdog's `RUNPOD_POD_NAME_MATCH`) is exactly the runaway-billing scenario this whole cutover exists to prevent.

**Desktop production environment wiring (Step 17):** SSH to desktop and revert `api/.env` to point `VISION_API_BASE`/`VISION_API_KEY`/`VISION_API_MODEL` back to the Gemini values (or unset them to restore the prior default). Then restart the service:
```bash
systemctl --user restart estate-scraper
```

**Service restart (Step 18):** The restart is immediate and reversible by restarting again with the prior environment. No further rollback needed if the prior steps are reverted.

If the full cutover must be rolled back after production verification, reverting Step 17 (and, if the RunPod endpoint is no longer wanted at all, deprovisioning it per the guidance above) restores the Gemini backend with no code changes required. Step 6's watchdog deployment can be left in place harmlessly (it simply never finds an estate-scraper pod to stop) or removed per the systemd rollback above if fully decommissioning RunPod.
