# estate-scraper

Scrapes estatesales.net listings and surfaces sales worth attending based on configurable keyword hunts. The vision pipeline runs a cost cascade — cheap signals gate expensive compute at each stage so RunPod serverless inference is only invoked on images that survive free pixel checks, a local Ollama gate, and adaptive sampling.

[![CI](https://github.com/prestonbernstein/estate-scraper/actions/workflows/ci.yml/badge.svg)](https://github.com/prestonbernstein/estate-scraper/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## How it works

```
estatesales.net
      │
      ▼
  Scraper (Node.js)
      │  listings within configured radius
      ▼
  pHash dedup                              free  — Sharp pixel math, no model
      │  near-duplicate images removed
      ▼
  Adaptive sampling                        free  — score arithmetic
      │  lead 25% → score → tail probe if weak → EARLY_STOP
      │  sales with no signal dropped before any model is called
      ▼
  Quality gate                             free  — brightness + variance check
      │  dark / blurry images rejected
      ▼
  Local Qwen3 gate                         cheap — local GPU, ~1 s/image
      │  exteriors, empty rooms, HVAC → SKIP     [RunPod mode only]
      ▼
  Full vision                              expensive — RunPod serverless or local Ollama
      │  qwen3-vl:30b · confidence tags ([high] / [medium] / [low])
      ▼
  Oracle escalation                        expensive — cloud VL model, per sale
      │  uncertain-zone sales (score 0.1–0.6) only
      ▼
  SQLite (Drizzle ORM)
      │
      ▼
  Hono API  ←→  React UI
```

### Cost cascade

Each stage is ordered by cost. A free check gates a cheap check; a cheap check gates an expensive one. RunPod inference is only invoked on images that survive everything upstream.

| Stage | Cost | What it rejects |
|---|---|---|
| pHash dedup | free | Near-duplicate images (CDN resizes, repeated hero shots) |
| Adaptive sampling | free | Entire sales with no signal in lead + tail probe |
| Quality gate | free | Dark or blurry images (pixel variance / mean brightness) |
| Local Qwen3 gate | cheap (local GPU) | Exteriors, empty rooms, HVAC, price boards — active in RunPod mode only |
| Full vision | expensive (RunPod or local Ollama) | — |
| Oracle escalation | expensive (cloud VL model) | Skipped unless sale score is in uncertain zone (0.1–0.6) |

The local gate only activates when `RUNPOD_ENDPOINT_ID` is set. Running a second local model call to gate the first local model call has no cost benefit; the gate exists to reduce paid RunPod invocations.

### Adaptive sampling

1. **Lead sample** — analyze the first 25% of unique images, compute a weighted sale score
2. **High confidence** (score ≥ 0.8) — proceed to full pass immediately
3. **Low signal** (score < 0.1) — probe 8 random images from the last 30%
4. **Tail probe empty** — sale is dropped (`EARLY_STOP`), no further model calls
5. **Uncertain zone** (score 0.1–0.6 after full pass) — escalate to oracle

Each finding line carries a plain-text confidence tag (`[high]`, `[medium]`, or `[low]`). Plain text outperformed JSON-constrained output 89% vs 50% in eval.

### Hunt matching

Users define keyword hunts (e.g. `velvet painting`, `Atari`, `Stickley`). Findings are matched at query time and weighted by confidence. The discover page ranks sales by aggregate weighted score.

### Feedback loop

After attending a sale, users log an outcome (`good` / `meh` / `waste`). Outcomes are stored alongside `imagePositionPct` and `confidence` columns to support future threshold calibration.

## Stack

| Layer | Tech |
|---|---|
| Scraper | Node.js, custom HTML parser |
| Image pre-filter | Sharp (pHash dedup, quality gate) |
| Vision — local | Ollama `qwen3-vl:30b` on AMD RX 9070 XT |
| Vision — cloud | RunPod serverless (`RUNPOD_ENDPOINT_ID`; local Qwen3 gate activates) |
| Oracle | OpenAI-compatible API (RunPod, Together, Hyperbolic) for uncertain-zone sales |
| API | Hono, SQLite, Drizzle ORM |
| UI | React, Vite, Tailwind CSS |
| Auth | JWT via OIDC / Authentik (stub mode for local dev) |
| Eval | Custom harness comparing prompt variants against labeled images |

## Monorepo layout

```
api/          Hono API, scraper, vision pipeline, scan runner
  src/
    lib/        scraping.ts · vision.ts · sampling.ts · date.ts · geo.ts
    scraper/    estatesales.net HTML parser
    vision/     Ollama inference, adaptive sampling, oracle escalation
    scan/       orchestrator, SQLite persistence, scan state
    services/   sale queries, hunt matching, scoring
    routes/     Hono route handlers
    db/         Drizzle schema + migrations
  eval/         prompt evaluation harness
ui/           React + Vite frontend
docs/         architecture decisions, specs
scripts/      LaunchAgent plist, deploy helpers
```

## Quick start

**Prerequisites:** Node.js ≥ 22, Ollama with a vision model loaded, SQLite (bundled).

```bash
git clone https://github.com/prestonbernstein/estate-scraper
cd estate-scraper
cp api/.env.example api/.env
# edit api/.env — set HOME_LAT, HOME_LON, and OLLAMA_HOST at minimum
npm install
npm run db:migrate --workspace=api
npm run dev          # starts API on :3000 and UI on :5173
```

## Configuration

All config lives in `api/.env`. See [`api/.env.example`](api/.env.example) for the full list.

| Variable | Default | Description |
|---|---|---|
| `HOME_LAT` / `HOME_LON` | — | Center point for radius filtering |
| `HOME_ADDRESS` / `HOME_CITY` / `HOME_STATE` / `HOME_ZIP` | — | Display only, not geocoded |
| `OLLAMA_HOST` | `http://localhost:11436` | Ollama endpoint (broker port recommended) |
| `OLLAMA_MODEL` | `qwen3-vl:30b` | Any Ollama vision model |
| `RUNPOD_ENDPOINT_ID` | — | RunPod serverless endpoint; enables local Qwen3 gate |
| `RUNPOD_API_KEY` | — | RunPod API key |
| `RUNPOD_MODEL` | `Qwen/Qwen3-VL-32B-Instruct` | Model served on the RunPod endpoint |
| `AUTH_MODE` | `stub` | `stub` · `forwarded` · `jwt` |
| `OIDC_ISSUER` | — | Required when `AUTH_MODE=jwt` |
| `ORACLE_API_BASE` | — | OpenAI-compat base URL for uncertain-zone escalation |
| `ORACLE_API_KEY` | — | Key for oracle model |
| `ORACLE_MODEL` | — | e.g. `Qwen/Qwen2.5-VL-72B-Instruct` |

## Running a scan

```bash
npm run scan
```

Scrapes listings within the configured radius, runs the vision pipeline, persists findings to SQLite. Designed to run as a scheduled job (see [`scripts/com.estate-scraper.scan.plist`](scripts/com.estate-scraper.scan.plist) for a macOS LaunchAgent).

## Eval

Measures detection accuracy and specificity across prompt variants on a labeled image set.

```bash
npm run eval                              # run all prompt variants
npm run eval -- --compare                 # side-by-side comparison
npm run eval -- --prompt chat-kitsch-confidence  # single variant
```

Results print to stdout; edit `api/eval/labels.json` to add labeled images.

## Architecture decisions

Nine ADRs in [`docs/adr/`](docs/adr/) document the key choices: SQLite over flat files, generic vision pass with hunt-time filtering, scheduled scans over manual triggers, OIDC auth via Authentik, and more.

## License

MIT — see [LICENSE](LICENSE).
