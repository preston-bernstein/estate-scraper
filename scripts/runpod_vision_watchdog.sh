#!/usr/bin/env bash
# RunPod vision pod auto-stop watchdog — run by a systemd timer under the
# estate-scraper service user on the desktop (see systemd/estate-scraper-runpod-watchdog.*).
#
# RunPod dedicated pods bill by the hour for as long as desiredStatus=RUNNING,
# whether or not anything is using them — there's no built-in idle-stop like
# serverless endpoints have. This closes that gap for the Tier-2 vision pod.
#
# Idle signal: api/data/scan-state.json's `phase` field, NOT the `running` boolean.
# `running` stays true for the whole Scan, including Tier 0/1 (scraping, pHash/
# quality gate, SigLIP ranking) — none of which calls RunPod. Only `phase ==
# "analyzing"` means the Tier-2 vision backend is actually in use. Treating
# `!running` as idle would let the watchdog think the pod is "busy" for however
# long Tier 0/1 takes before the first vision call, wasting exactly the billing
# window this script exists to close. See docs/runpod-vision-cutover/plan.md
# Design decisions #1.
#
# Mechanism mirrors ~/dev/algo-corpus/scripts/runpod_ingest_watchdog.sh's real,
# proven pattern: a SINGLE-EXECUTION inline confirm — read state once, and if
# idle, sleep an inline cooldown, re-read once more, and only then act — all
# within one script run, one systemd-timer firing. No persistent counter file
# (of the kind that would live under a scratch/temp directory) surviving
# across separate timer firings (that was an earlier, rejected design — see
# plan.md Design decisions #2). estate-scraper's cooldown is ~5
# minutes (vs. algo-corpus's 60s) per the plan's cooldown decision.
#
# Env (set in api/.env):
#   RUNPOD_API_KEY          required — RunPod account-level management API key.
#   RUNPOD_POD_NAME_MATCH   optional — default "estate-scraper-vision". Exact
#                           match or strict prefix ("<match>-*") only, never a
#                           loose substring — a shared RunPod account (same key
#                           as algo-corpus's own dedicated pods) makes a loose
#                           substring match a real risk of stopping (or failing
#                           to stop) the wrong project's GPU. See plan.md Design
#                           decisions #4.
#   SCAN_STATE_PATH         optional — same default as the app itself
#                           (./data/scan-state.json, resolved relative to api/,
#                           which this script cd's into before reading it).
#   WATCHDOG_MAX_SCAN_HOURS required — positive integer hours. Staleness/crash
#                           guard: if phase=="analyzing" (nominally active) but
#                           scan-state.json's startedAt is older than this many
#                           hours, the Scan almost certainly died without
#                           resetting state (SIGKILL, OOM, host reboot) and the
#                           pod is stopped anyway, immediately, independent of
#                           the idle-confirm cooldown path below. No baked-in
#                           default — missing or non-positive-integer values
#                           fail loud at startup rather than silently falling
#                           back to a guessed number. See plan.md Design
#                           decisions (staleness guard) and requirement 6.
#   NTFY_URL                optional — alert endpoint for the fail-loud path.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/api" || exit 1

# Load .env — same pattern as the algo-corpus precedent and this repo's own
# scripts/run-scan.sh.
set -a
[ -f .env ] && . ./.env
set +a

: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY in api/.env}"
RUNPOD_POD_NAME_MATCH="${RUNPOD_POD_NAME_MATCH:-estate-scraper-vision}"
SCAN_STATE_PATH="${SCAN_STATE_PATH:-./data/scan-state.json}"

# Inline idle-confirm cooldown, in seconds (~5 min — the plan's cooldown decision,
# distinct from algo-corpus's 60s since this is a slower-moving Scan cadence).
IDLE_CONFIRM_SLEEP_S=300

LOG_FILE="runpod-watchdog.log"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG_FILE"; }

runpod_gql() {
  curl -sS -m 20 "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
    -H "Content-Type: application/json" -d "$1"
}

ntfy() {
  [ -n "${NTFY_URL:-}" ] && curl -s -m 10 -d "$1" "$NTFY_URL" >/dev/null 2>&1 || true
}

# --- WATCHDOG_MAX_SCAN_HOURS validation (fail loud, no baked-in default) ---
# Required so the staleness guard below always has a real bound. Missing or
# non-positive-integer values are a config error, not something to paper over
# with a guessed number — a silently-wrong default here is exactly the
# runaway-billing failure mode this script exists to prevent.
if [ -z "${WATCHDOG_MAX_SCAN_HOURS:-}" ]; then
  log "ERROR: WATCHDOG_MAX_SCAN_HOURS is not set in api/.env — required (no built-in default). Refusing to run."
  ntfy "estate-scraper watchdog: WATCHDOG_MAX_SCAN_HOURS unset — watchdog refusing to run"
  exit 1
fi
case "$WATCHDOG_MAX_SCAN_HOURS" in
  ''|*[!0-9]*)
    log "ERROR: WATCHDOG_MAX_SCAN_HOURS='${WATCHDOG_MAX_SCAN_HOURS}' is not a positive integer. Refusing to run."
    ntfy "estate-scraper watchdog: WATCHDOG_MAX_SCAN_HOURS invalid ('${WATCHDOG_MAX_SCAN_HOURS}') — watchdog refusing to run"
    exit 1
    ;;
esac
if [ "$WATCHDOG_MAX_SCAN_HOURS" -le 0 ]; then
  log "ERROR: WATCHDOG_MAX_SCAN_HOURS must be a positive integer (>0), got '${WATCHDOG_MAX_SCAN_HOURS}'. Refusing to run."
  ntfy "estate-scraper watchdog: WATCHDOG_MAX_SCAN_HOURS=${WATCHDOG_MAX_SCAN_HOURS} not > 0 — watchdog refusing to run"
  exit 1
fi

# Read the `phase` field off scan-state.json. Prints nothing on a missing or
# unparsable file — callers treat that as "unknown" and never assume idle blind.
read_phase() {
  python3 -c "
import json, sys
try:
    with open('${SCAN_STATE_PATH}') as f:
        d = json.load(f)
    print(d.get('phase', ''))
except Exception:
    pass
"
}

# Read the `startedAt` field off scan-state.json as a Unix epoch (float
# seconds, printed on stdout). Prints nothing on a missing file, missing
# field, or unparsable timestamp — the staleness check below treats that as
# "unknown" and never assumes staleness blind, same fail-safe shape as
# read_phase.
read_started_at_epoch() {
  python3 -c "
import json
from datetime import datetime, timezone

try:
    with open('${SCAN_STATE_PATH}') as f:
        d = json.load(f)
except Exception:
    raise SystemExit(0)

started_at = d.get('startedAt')
if not started_at:
    raise SystemExit(0)

if isinstance(started_at, (int, float)):
    print(started_at)
    raise SystemExit(0)

s = str(started_at)
dt = None
for parse in (
    lambda v: datetime.strptime(v, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc),
    lambda v: datetime.strptime(v, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc),
    lambda v: datetime.fromisoformat(v.replace('Z', '+00:00')),
):
    try:
        dt = parse(s)
        break
    except Exception:
        continue

if dt is None:
    raise SystemExit(0)

print(dt.timestamp())
"
}

# Query RunPod for RUNNING pods matching RUNPOD_POD_NAME_MATCH and stop each
# one. Shared by both the normal idle-confirm path and the staleness-guard
# path below — same GraphQL calls, same fail-loud error handling, only the
# logged "reason" differs. $1 = human-readable reason, for logging only.
stop_idle_pods() {
  local reason="$1"
  log "querying RunPod for running pods matching '${RUNPOD_POD_NAME_MATCH}' (${reason})"

  gql_response="$(runpod_gql '{"query":"query { myself { pods { id name desiredStatus costPerHr } } }"}')"
  curl_status=$?

  if [ "$curl_status" -ne 0 ] || [ -z "$gql_response" ]; then
    log "ERROR: RunPod GraphQL call failed (curl exit=${curl_status}) — nothing was touched"
    ntfy "estate-scraper watchdog: RunPod GraphQL call failed — could not read pod list, nothing touched"
    exit 1
  fi

  if echo "$gql_response" | grep -q '"errors"'; then
    log "ERROR: RunPod GraphQL response contained an errors key — nothing was touched. Response: ${gql_response}"
    ntfy "estate-scraper watchdog: RunPod GraphQL returned an errors key — could not read pod list, nothing touched"
    exit 1
  fi

  running_pods="$(echo "$gql_response" | python3 -c "
import sys, json
match = '${RUNPOD_POD_NAME_MATCH}'
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for p in d.get('data', {}).get('myself', {}).get('pods', []) or []:
    name = p.get('name') or ''
    # Exact match or strict prefix only — never a loose substring (plan.md
    # Design decisions #4). A bare startswith() without the hyphen boundary
    # could still false-match e.g. 'estate-scraper-vision2'.
    if p.get('desiredStatus') == 'RUNNING' and (name == match or name.startswith(match + '-')):
        print(p['id'])
")"

  if [ -z "$running_pods" ]; then
    log "idle, nothing to stop — no RUNNING pod matching '${RUNPOD_POD_NAME_MATCH}' (${reason})"
    exit 0
  fi

  for pod_id in $running_pods; do
    log "idle confirmed (${reason}) — stopping pod ${pod_id}"
    stop_response="$(runpod_gql "{\"query\":\"mutation { podStop(input: {podId: \\\"${pod_id}\\\"}) { id desiredStatus } }\"}")"
    echo "$stop_response" >> "$LOG_FILE"
    if [ -z "$stop_response" ] || echo "$stop_response" | grep -q '"errors"'; then
      log "ERROR: podStop for ${pod_id} failed or returned an errors key: ${stop_response}"
      ntfy "estate-scraper watchdog: podStop failed for pod ${pod_id}"
      exit 1
    fi
    log "idle, stopped pod ${pod_id}"
    ntfy "estate-scraper: RunPod pod stopped, idle (${reason}): ${pod_id}"
  done

  log "=== watchdog done ==="
}

phase="$(read_phase)"
if [ -z "$phase" ]; then
  log "WARN: could not read phase from ${SCAN_STATE_PATH} — not touching any pod"
  exit 0
fi

if [ "$phase" = "analyzing" ]; then
  # Staleness/crash guard: phase says "analyzing" (nominally active), but if
  # startedAt is older than WATCHDOG_MAX_SCAN_HOURS, the Scan almost
  # certainly died without resetting state (SIGKILL, OOM, host reboot) rather
  # than genuinely still running this long. Stop the pod immediately —
  # skipping the inline cooldown recheck below, since a process already dead
  # for hours won't become "less dead" after another 5 minutes.
  started_epoch="$(read_started_at_epoch)"
  if [ -n "$started_epoch" ]; then
    now_epoch="$(date +%s)"
    started_epoch_int="${started_epoch%%.*}"
    age_s=$(( now_epoch - started_epoch_int ))
    max_s=$(( WATCHDOG_MAX_SCAN_HOURS * 3600 ))
    if [ "$age_s" -gt "$max_s" ]; then
      log "staleness guard triggered: phase=analyzing but startedAt is ${age_s}s old (> WATCHDOG_MAX_SCAN_HOURS=${WATCHDOG_MAX_SCAN_HOURS}h = ${max_s}s) — Scan likely crashed without resetting state; treating as idle and stopping now"
      stop_idle_pods "staleness guard, startedAt ${age_s}s old"
      exit 0
    fi
  fi
  log "active, skipping (phase=analyzing) — RunPod in use, pod stays up"
  exit 0
fi

log "idle (phase=${phase}) — confirming before stopping anything (sleeping ${IDLE_CONFIRM_SLEEP_S}s)"
sleep "$IDLE_CONFIRM_SLEEP_S"

phase2="$(read_phase)"
if [ -z "$phase2" ]; then
  log "WARN: could not re-read phase on recheck — not touching any pod"
  exit 0
fi

if [ "$phase2" = "analyzing" ]; then
  log "became active during cooldown (phase=${phase2}) — pod stays up"
  exit 0
fi

log "confirmed idle (phase=${phase2})"
stop_idle_pods "idle-confirmed, phase=${phase2}"
