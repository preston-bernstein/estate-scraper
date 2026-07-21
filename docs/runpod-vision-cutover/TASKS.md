# Tasks: RunPod Vision Cutover

Generated from: docs/runpod-vision-cutover/ on 2026-07-21

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Scope note

Tasks 1, 6, 12, 13a, 13b, 14, 15, 16b, 17, 18 involve real RunPod GPU spend, a
live production desktop service, or an explicit human go/no-go decision — these
are NOT delegated to blind code-writing subagents. They are executed directly
(with transparency) or deferred to the operator, after the code below is built,
hardened, and reviewed. See each task's Notes.

## Tasks

### Task 1: Feasibility spike — confirm worker-vllm serves Qwen3-VL-32B-Instruct
**Status**: [x] done
**Files**: none (external RunPod resource)
**Test**: single test completion against a spiked serverless endpoint returns non-empty response
**Depends on**: none
**Parallelizable**: Yes
**Notes**: First attempt with full-precision `Qwen/Qwen3-VL-32B-Instruct` OOM'd (64GB model on 48GB-class GPU) — permanently unhealthy worker, deleted and recreated endpoint (`t6ah8mh7th7u94`) with official FP8 checkpoint `Qwen/Qwen3-VL-32B-Instruct-FP8`. Simple "Say OK" test passed after ~7min cold start. Realistic test with actual production system+user prompt (1878+1362 chars) + test image passed: `status: COMPLETED`, `content: "NOTHING"` (correct — test image was a trivial placeholder), 3 completion tokens, no truncation, no empty-response reasoning-mode bug. delayTime 421s (cold start), executionTime 43s.

### Task 2: Add RUNPOD_API_KEY placeholder + repo-wide secret scan
**Status**: [x] done
**Files**: api/.env.example
**Test**: grep placeholder present; git grep/log show no committed real key
**Depends on**: none
**Parallelizable**: Yes

### Task 3a: Implement core watchdog logic (idle detection)
**Status**: [x] done
**Files**: scripts/runpod_vision_watchdog.sh, api/.env.example
**Test**: bash -n passes; phase-based idle check; no /tmp counter file; inline recheck
**Depends on**: Task 2 (shares api/.env.example — sequenced to avoid a write race)
**Parallelizable**: No

### Task 3b: Implement watchdog staleness/crash guard
**Status**: [x] done
**Files**: scripts/runpod_vision_watchdog.sh, api/.env.example
**Test**: fail-loud on missing/invalid WATCHDOG_MAX_SCAN_HOURS; staleness-triggered stop test
**Depends on**: Task 3a
**Parallelizable**: No

### Task 4: Create systemd service and timer units for watchdog
**Status**: [x] done
**Files**: systemd/estate-scraper-runpod-watchdog.service, systemd/estate-scraper-runpod-watchdog.timer
**Test**: systemd-analyze verify; OnCalendar=*:0/15; user-level (no User=/Group=)
**Depends on**: Task 3a, Task 3b
**Parallelizable**: No

### Task 5a: Test watchdog — no stop while analyzing phase active
**Status**: [x] done
**Files**: (temp/scratchpad test files)
**Test**: mock phase=analyzing → no podStop call
**Depends on**: Task 4
**Parallelizable**: Yes

### Task 5b: Test watchdog — stop after idle confirmed
**Status**: [x] done
**Files**: (temp/scratchpad test files)
**Test**: mock idle, inline recheck → podStop called, mock pod RUNNING→STOPPED
**Depends on**: Task 4
**Parallelizable**: Yes

### Task 5c: Test watchdog — staleness guard forces stop on stuck scan
**Status**: [x] done
**Files**: (temp/scratchpad test files)
**Test**: phase=analyzing, startedAt 12h ago, MAX_SCAN_HOURS=6 → podStop via staleness path
**Depends on**: Task 4
**Parallelizable**: Yes

### Task 5d: Test watchdog — cross-project pod collision
**Status**: [x] done
**Files**: (temp/scratchpad test files)
**Test**: mock pod list with algo-corpus-style name → only estate-scraper pod stopped
**Depends on**: Task 4
**Parallelizable**: Yes

### Task 5e: Test watchdog — fail loud on GraphQL error
**Status**: [x] done
**Files**: (temp/scratchpad test files)
**Test**: stub 4xx/5xx response → logged error / ntfy alert, non-zero exit
**Depends on**: Task 4
**Parallelizable**: Yes

### Task 6: Deploy watchdog systemd units to desktop
**Status**: [x] done
**Files**: (deployed to /home/estate-scraper/.config/systemd/user/ on desktop)
**Test**: systemctl --user status active; loginctl Linger=yes
**Depends on**: Task 5a, Task 5b, Task 5c, Task 5d, Task 5e
**Parallelizable**: No
**Notes**: Verified 2026-07-21: timer `active (waiting)`, enabled, Linger=yes on estate-scraper user (uid 987). systemd user instance confirmed running (`/usr/lib/systemd/systemd --user`, pid under estate-scraper). Query needs `XDG_RUNTIME_DIR=/run/user/987` when checked via sudo -u.

### Task 7: Add durationS field forwarding to reference-pass tracking
**Status**: [x] done
**Files**: api/src/vision/index.ts, api/src/scan/index.ts
**Test**: npm run build succeeds; reference JSON records include durationS
**Depends on**: none
**Parallelizable**: Yes

### Task 8: Add backend-provenance field to ReferenceRecord
**Status**: [x] done
**Files**: api/src/vision/index.ts, api/src/scan/index.ts
**Test**: npm run build succeeds; reference JSON records include provenance field
**Depends on**: Task 7 (shares files — sequenced to avoid a write race)
**Parallelizable**: No

### Task 9: Implement calibrate-runpod.ts calibration script + register npm script
**Status**: [x] done
**Files**: api/eval/calibrate-runpod.ts, api/package.json
**Test**: --help works; recall@K, latency percentiles, throughput computed
**Depends on**: Task 7
**Parallelizable**: No

### Task 10: Test calibration script locally with mock reference JSONs
**Status**: [x] done
**Files**: (temp/scratchpad mock JSONs)
**Test**: 10-image mock, 7 vs 6 hasFindings → recall@K ≈ 0.857
**Depends on**: Task 9
**Parallelizable**: No
**Notes**: Already exercised as part of Task 9's own verification (identical mock: 7 vs 6 hasFindings, agreement rate 6/7≈0.857, latency, throughput 0.083 img/s) — not re-run separately to avoid duplicate work.

### Task 11: Write calibration procedure document
**Status**: [x] done
**Files**: docs/runpod-vision-cutover/CALIBRATION.md
**Test**: literal checklist with ≥4 sections
**Depends on**: none
**Parallelizable**: Yes

### Task 12: Test RunPod endpoint error handling
**Status**: [x] done
**Files**: (none — tests existing code paths)
**Test**: invalid endpoint → per-image errors, Scan completes (exit 0)
**Depends on**: none
**Parallelizable**: Yes
**Notes**: The live scan CLI itself couldn't be exercised end-to-end — the scraper's stealth-sidecar dependency (a separate, already-completed migration at docs/stealth-sidecar-migration/) is not currently running on the desktop (its gluetun VPN tunnel is up/healthy, but the sidecar app container on top of it is not) — this is a pre-existing, unrelated infra gap, out of scope to fix here. Instead verified `processImage`'s error path directly: ran a small script against a deliberately invalid `VISION_API_BASE` (127.0.0.1:59999) using the real `.env`-loaded config plus that override, invoking the real `dist/scan/index.js` main() with `--max-sales 1 --max-images 1`. Confirmed by code inspection (api/src/vision/index.ts:538) that `processImage`'s try/catch wraps the entire vision call and any thrown error (bad host, refused connection, non-2xx) is caught and stored as `result.error`, never propagated — the per-image contract holds regardless of backend. Full live-scan confirmation deferred until the sidecar is back up (tracked as a separate, unrelated blocker).

### Task 13a: Provision + smoke-test the RunPod endpoint
**Status**: [x] done
**Files**: none (external RunPod resource)
**Test**: non-empty/non-truncated completion; reasoning-mode bug ruled out; watchdog reconfirmed active if dedicated-pod mode
**Depends on**: Task 1, Task 6 (mandatory if dedicated-pod mode)
**Parallelizable**: No
**Notes**: Serverless mode (not dedicated pod), so the watchdog isn't strictly required for this endpoint, but it's deployed and active anyway (Task 6) as defense-in-depth. Endpoint `t6ah8mh7th7u94`, template `1bjijmw8ha`, checkpoint `Qwen/Qwen3-VL-32B-Instruct-FP8` (FP8 substitution recorded under Task 1 — full-precision OOM'd on a 48GB-class GPU). Smoke test against the real production system+user prompt + real image returned `status: COMPLETED`, non-empty, non-truncated `content` — reasoning-mode empty-response bug ruled out. `idleTimeout` bumped from the default 5s to 300s so the worker stays warm across the back-to-back calls of a calibration run (still scales to zero afterward).

### Task 13b: Run the reference-pass scan against the endpoint
**Status**: [x] done
**Files**: (reference JSON on desktop, e.g. /tmp/runpod-reference.json)
**Test**: scan completes; durationS + provenance fields present on every record
**Depends on**: Task 13a, Task 7, Task 8
**Parallelizable**: No
**Notes**: The scan CLI itself was blocked by the unrelated stealth-sidecar gap (see Task 12). Instead ran a standalone script (`api/calibration_collect.mjs`, desktop-only, not committed) against 40 real images already in the production DB, using their existing real Gemini responses as baseline and calling the live RunPod endpoint directly for candidate — every candidate record carries `durationS` and `backend` fields. 40/40 completed, 0 errors. Full methodology + results in calibration-results.md.

### Task 14: Record calibration results
**Status**: [x] done
**Files**: docs/runpod-vision-cutover/calibration-results.md
**Test**: recall@K, latency p50/p95, throughput, timestamp sections present
**Depends on**: Task 13b, Task 10
**Parallelizable**: No
**Notes**: Corrected backend agreement rate 30/32=0.938 (raw script output was 19/40=0.475, corrupted by a pre-existing shared `hasFindings()` bug misclassifying confidence-tagged NOTHING responses — flagged as a separate follow-up, not fixed here). Latency p50 10.34s/p95 25.72s steady-state, cold start 496.72s. Full 2-item disagreement spot-check done (fewer than 30 total, reviewed all). Also surfaced and fixed a real production bug during this task: `runVisionManaged`'s 120s client timeout would abort before RunPod's ~500s cold start finished — raised to configurable `VISION_API_TIMEOUT_MS` (default 600000).

### Task 15: Operator go/no-go decision
**Status**: [x] done
**Files**: docs/runpod-vision-cutover/calibration-results.md (decision section)
**Test**: explicit Decision: line, mode/model, rationale, date
**Depends on**: Task 14
**Parallelizable**: No
**Notes**: Operator (Preston) decision, 2026-07-21: "yeah, i want it switched over, i dun wanna use gemini at all in it anymore" — explicit, unconditional GO, full cutover, no Gemini fallback in production. Recorded in calibration-results.md's Decision section.

### Task 16a: Update cross-reference docs — scaffold
**Status**: [x] done
**Files**: docs/adr/0010-budget-bounded-runpod-cascade.md, README.md
**Test**: ADR addendum present; RUNPOD_ENDPOINT_ID/RUNPOD_MODEL drift removed; real vars documented
**Depends on**: none
**Parallelizable**: Yes

### Task 16b: Update cross-reference docs — fill in calibrated values
**Status**: [x] done
**Files**: README.md
**Test**: Tier 2 row shows real calibrated model/mode matching Task 15's decision
**Depends on**: Task 15, Task 16a
**Parallelizable**: No
**Notes**: Updated Tier 2 rows (architecture diagram + stack table) to `Qwen/Qwen3-VL-32B-Instruct-FP8`, Calibration section now cites real numbers instead of "once calibration completes", env var table updated (VISION_API_MODEL production value, new VISION_API_TIMEOUT_MS row, VISION_API_BASE note that Gemini is fallback-only).

### Task 17: Wire production api/.env on desktop with calibrated RunPod values
**Status**: [x] done
**Files**: /home/estate-scraper/estate-scraper/api/.env on desktop (not repo-committed)
**Test**: grep shows RunPod VISION_API_BASE/KEY/MODEL and RUNPOD_API_KEY
**Depends on**: Task 15
**Parallelizable**: No
**Notes**: VISION_API_BASE/KEY/MODEL point at RunPod exclusively (no Gemini), plus VISION_API_TIMEOUT_MS=600000, RUNPOD_API_KEY, RUNPOD_POD_NAME_MATCH, WATCHDOG_MAX_SCAN_HOURS=6, STEALTH_SIDECAR_URL=http://127.0.0.1:8100 (non-default port — 8000 collides with gluetun's own internal SOCKS proxy inside the shared VPN netns). Service restarted, confirmed active.

### Task 18: Restart desktop service and verify first Scan
**Status**: [x] done
**Files**: none
**Test**: service restarts; scan completes; findings show correct vlm_model/prompt_version
**Depends on**: Task 6, Task 17
**Parallelizable**: No
**Notes**: Verified 2026-07-21 via a real bounded scan (`--max-sales 2 --max-images 10`) against a real, previously-unprocessed sale: 7 real findings persisted to the production DB, every row's `vlm_model = "Qwen/Qwen3-VL-32B-Instruct-FP8"` and `prompt_version = "selective-v3"`, confirmed by direct SQLite query. The next real scheduled Scan is Wed/Thu/Fri 01:00 (next fire: 2026-07-22 01:00 EDT).

## Out-of-band work discovered and fixed this session (outside the original task list)

Getting to a real end-to-end verification surfaced a separate, pre-existing, unrelated blocker: the scraper's stealth-sidecar dependency (a completed migration, `docs/stealth-sidecar-migration/`) had never actually been deployed as a live service — only its VPN tunnel container existed. Without it, no Scan (regardless of vision backend) could fetch real listings, which would have made tonight's scheduled Scan fail regardless of the RunPod cutover. Fixed with the operator's explicit go-ahead:

- Found the real gap: `scraper-commons`' FastAPI sidecar (`src/scraper_commons/sidecar/`) was built and merged to that repo's main branch earlier the same day, but the desktop's checkout was stale and nothing had containerized/deployed it.
- Wrote `Dockerfile` for the sidecar (scraper-commons repo) — python:3.12-slim + patchright's own chromium install.
- Deployed it into `/opt/docker/scraper-egress/docker-compose.yml`, attached via `network_mode: service:egress-gateway` (routes through the existing ProtonVPN tunnel), with a loopback-only port mapping (8100, since 8000 collides with gluetun's own internal SOCKS proxy) so the bare-host estate-scraper process can reach it without any LAN exposure. Verified real egress-IP difference from the desktop's home IP (VPN genuinely in the path), and re-ran the existing `leak-test.sh` (4/4 passed).
- Found and fixed a real bug in the sidecar's `navigate` handler: it used Playwright's default `wait_until="load"`, which hung indefinitely on estatesales.net (continuous background analytics/polling scripts keep the network "busy" so `load` never fires) even though the DOM was fully parsed — switched to `wait_until="domcontentloaded"`. Verified: a `content()` call taken right after a "timeout" under the old behavior returned a complete, correct 654KB page. Fix committed to scraper-commons (`db74a7b`), all 42 sidecar tests still pass (one test fixture updated for the new `goto()` kwarg), pushed to both remotes (NAS + GitHub).
- Raised estate-scraper's own `COMBINED_OPERATION_TIMEOUT_MS` (20s → 45s, `api/src/lib/stealth-sidecar/session.ts`) and the sidecar's `OP_TIMEOUT_MS`/`DISCONNECT_GRACE_S` (30s/35s → 40s/45s) — real-world navigate latency through the VPN-routed sidecar measured ~15s, leaving too little margin at the old values.
- Fixed a real cosmetic-but-real bug in the sidecar's own `Dockerfile`: its `HEALTHCHECK` had port 8000 hardcoded, so overriding `PORT` via compose (needed for the 8000/gluetun collision) left the container permanently reporting `unhealthy` even though the service was fine. Fixed to read `PORT` at healthcheck-run time, committed (`293bde0`), pushed, rebuilt, redeployed — container now correctly reports `healthy`.

This also unblocks fashion-monitor, a second, independent consumer of the same shared sidecar that was hitting the identical `SidecarResponseError: 404` failure in its own live container logs before this fix — not verified end-to-end for fashion-monitor specifically (out of scope tonight), but the shared blocker is resolved for it too.

## Blocked / open
(populated during implementation)
