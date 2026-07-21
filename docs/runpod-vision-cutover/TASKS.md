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
**Status**: [ ] pending
**Files**: none (external RunPod resource)
**Test**: single test completion against a spiked serverless endpoint returns non-empty response
**Depends on**: none
**Parallelizable**: Yes
**Notes**: Real RunPod spend (minimal, serverless) — deferred to direct execution after code build, not a coding-agent task.

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
**Status**: [ ] pending
**Files**: (deployed to ~/.local/share/systemd/user/ on desktop)
**Test**: systemctl --user status active; loginctl Linger=yes
**Depends on**: Task 5a, Task 5b, Task 5c, Task 5d, Task 5e
**Parallelizable**: No
**Notes**: Real production desktop action — executed directly after code build, not a coding-agent task.

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
**Status**: [ ] pending
**Files**: (none — tests existing code paths)
**Test**: invalid endpoint → per-image errors, Scan completes (exit 0)
**Depends on**: none
**Parallelizable**: Yes
**Notes**: Touches the live desktop scan pipeline — executed directly, not a coding-agent task.

### Task 13a: Provision + smoke-test the RunPod endpoint
**Status**: [ ] pending
**Files**: none (external RunPod resource)
**Test**: non-empty/non-truncated completion; reasoning-mode bug ruled out; watchdog reconfirmed active if dedicated-pod mode
**Depends on**: Task 1, Task 6 (mandatory if dedicated-pod mode)
**Parallelizable**: No
**Notes**: Real RunPod spend — deferred to direct execution, not a coding-agent task.

### Task 13b: Run the reference-pass scan against the endpoint
**Status**: [ ] pending
**Files**: (reference JSON on desktop, e.g. /tmp/runpod-reference.json)
**Test**: scan completes; durationS + provenance fields present on every record
**Depends on**: Task 13a, Task 7, Task 8
**Parallelizable**: No
**Notes**: Real RunPod spend + real scan run — deferred to direct execution.

### Task 14: Record calibration results
**Status**: [ ] pending
**Files**: docs/runpod-vision-cutover/calibration-results.md
**Test**: recall@K, latency p50/p95, throughput, timestamp sections present
**Depends on**: Task 13b, Task 10
**Parallelizable**: No
**Notes**: Depends on real calibration data from Task 13b.

### Task 15: Operator go/no-go decision
**Status**: [ ] pending
**Files**: docs/runpod-vision-cutover/calibration-results.md (decision section)
**Test**: explicit Decision: line, mode/model, rationale, date
**Depends on**: Task 14
**Parallelizable**: No
**Notes**: EXPLICIT HUMAN DECISION — must be made by the operator (Preston), not fabricated by an agent.

### Task 16a: Update cross-reference docs — scaffold
**Status**: [x] done
**Files**: docs/adr/0010-budget-bounded-runpod-cascade.md, README.md
**Test**: ADR addendum present; RUNPOD_ENDPOINT_ID/RUNPOD_MODEL drift removed; real vars documented
**Depends on**: none
**Parallelizable**: Yes

### Task 16b: Update cross-reference docs — fill in calibrated values
**Status**: [ ] pending
**Files**: README.md
**Test**: Tier 2 row shows real calibrated model/mode matching Task 15's decision
**Depends on**: Task 15, Task 16a
**Parallelizable**: No
**Notes**: Depends on Task 15's real decision.

### Task 17: Wire production api/.env on desktop with calibrated RunPod values
**Status**: [ ] pending
**Files**: /home/estate-scraper/estate-scraper/api/.env on desktop (not repo-committed)
**Test**: grep shows RunPod VISION_API_BASE/KEY/MODEL and RUNPOD_API_KEY
**Depends on**: Task 15
**Parallelizable**: No
**Notes**: Production cutover — depends on Task 15's real go decision.

### Task 18: Restart desktop service and verify first Scan
**Status**: [ ] pending
**Files**: none
**Test**: service restarts; scan completes; findings show correct vlm_model/prompt_version
**Depends on**: Task 6, Task 17
**Parallelizable**: No
**Notes**: Production verification — after Task 17.

## Blocked / open
(populated during implementation)
