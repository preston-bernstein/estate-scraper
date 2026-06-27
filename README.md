# estate-scraper

Scrapes estatesales.net listings, runs each photo through a local vision model, and surfaces sales worth attending based on configurable keyword hunts.

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
  Vision pipeline (Ollama)
      │  adaptive image sampling
      │  qwen2.5vl:7b-q8_0 on local GPU
      ▼
  Scoring + oracle
      │  uncertain-zone sales → remote VL model (RunPod / Together / Hyperbolic)
      ▼
  SQLite (Drizzle ORM)
      │
      ▼
  Hono API  ←→  React UI
```

### Adaptive image sampling

Analyzing every photo in every listing is expensive. The pipeline uses staged sampling to bail early on duds and focus compute where it matters:

1. **Lead sample** — analyze the first 25% of images, compute a sale score
2. **High confidence** (score ≥ 0.8) — continue to full analysis immediately
3. **Low signal** (score < 0.1) — probe 8 random images from the last 30% of the listing
4. **Tail probe comes up empty** — sale is dropped (`EARLY_STOP`)
5. **Uncertain zone** (score 0.1–0.6 after full analysis) — escalate to oracle

Each finding line includes a plain-text confidence tag (`[high]`, `[medium]`, or `[low]`). Plain text outperformed JSON-constrained output 89% vs 50% in eval, so that's what ships.

### Hunt matching

Users define keyword hunts (e.g. `velvet painting`, `Atari`, `Stickley`). Findings are matched at query time and weighted by confidence. The discover page ranks sales by aggregate weighted score.

### Feedback loop

After attending a sale, users log an outcome (`good` / `meh` / `waste`). Outcomes are stored alongside `imagePositionPct` and `confidence` columns to support future threshold calibration.

## Stack

| Layer | Tech |
|---|---|
| Scraper | Node.js, custom HTML parser |
| Vision | Ollama — `qwen2.5vl:7b-q8_0` on AMD RX 9070 XT |
| Oracle | OpenAI-compatible API (RunPod, Together, Hyperbolic) |
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
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `qwen2.5vl:7b-q8_0` | Any Ollama vision model |
| `AUTH_MODE` | `stub` | `stub` · `forwarded` · `jwt` |
| `OIDC_ISSUER` | — | Required when `AUTH_MODE=jwt` |
| `ORACLE_API_BASE` | — | OpenAI-compat base URL (optional) |
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
