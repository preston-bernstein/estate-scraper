# estate-scraper

Scrapes estatesales.net listings and surfaces sales worth attending based on configurable keyword hunts. The vision pipeline runs a cost cascade — free pixel checks and a near-free embedding ranker decide which images deserve a look, and the expensive strong-VLM tier runs only on the top images, bounded by a dollar budget rather than a score threshold. See [ADR 0010](docs/adr/0010-budget-bounded-runpod-cascade.md).

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
  Tier 0 · pHash dedup + quality gate      free  — Sharp pixel math, no model
      │  near-duplicate / dark / blurry images removed
      ▼
  Tier 1 · embedding ranker                ~free — CLIP/SigLIP, batched, no generation
      │  every survivor scored "plausibly worth a look", ranked
      ▼
  Budget gate                              the dial — top-K, K = budget ÷ cost/image
      │  per-sale floor + remainder by rank · cheap tiers never judge value
      ▼
  Tier 2 · strong VLM (top-K only)         expensive — RunPod serverless 32B
      │  identification + desirability · confidence tags ([high]/[medium]/[low])
      ▼
  SQLite (Drizzle ORM)
      │
      ▼
  Hono API  ←→  React UI
```

### Cost cascade

Stages are ordered by cost, and the expensive tier is bounded by a **dollar budget, not a score threshold** — so spend is a dial the operator sets, not an emergent outcome the gates have to hit. The cheap tiers do coarse **noise removal only**; they never judge whether an item is *valuable* (that is Tier 2's job), which keeps false-negatives — dropped good items — low. Both RunPod endpoints scale to zero, so cost is $0 outside the weekly Scan.

| Tier | Cost | Role |
|---|---|---|
| 0 · pHash dedup + quality gate | free (CPU) | Drop near-duplicates, dark/blurry images |
| 1 · embedding ranker | ~free (~$0.01–0.05/scan) | Rank every survivor by "plausibly worth a closer look" |
| Budget gate | — | Select the top-K images, `K = budget ÷ cost_per_image` |
| 2 · strong VLM | expensive (RunPod 32B) | Identify items + rate desirability — top-K images only |

**Budget-bounded escalation.** Tier 1 produces a ranking, not a pass/fail. The budget gate spends a per-scan image budget on the highest-ranked images first, allocated **per-sale floor + remainder**: every sale clearing Tier 0 gets a guaranteed minimum (e.g. top 4 images) to the 32B, then leftover budget goes to the best-ranked images globally — so photo-dense sales can't starve the rest. A miscalibrated ranker still cannot blow the budget; it only spends on slightly worse-ranked images.

Each finding line carries a plain-text confidence tag (`[high]`, `[medium]`, or `[low]`). Plain text outperformed JSON-constrained output 89% vs 50% in eval.

### Calibration

Cheap-tier choices (`K`, the per-sale floor, the ranker prompts/exemplars) are tuned against a one-time **reference pass**: a single money-no-object Scan that sends every image through the 32B (~$22, frozen). Thereafter `recall@K` — what fraction of the reference's findings the cascade actually selected — is measured offline for free, yielding a "$X/mo captures Y% of full-pass findings" curve. The budget is chosen from that curve, with data rather than guesswork. See [ADR 0010](docs/adr/0010-budget-bounded-runpod-cascade.md).

### Hunt matching

Users define keyword hunts (e.g. `velvet painting`, `Atari`, `Stickley`). Findings are matched at query time and weighted by confidence. The discover page ranks sales by aggregate weighted score.

### Feedback loop

After attending a sale, users log an outcome (`good` / `meh` / `waste`). Outcomes are stored alongside `imagePositionPct` and `confidence`, and feed back two ways: as confirmed-good / confirmed-junk exemplars for the Tier-1 ranker, and as a re-weighting signal that pulls the generic desirability prior toward the user's actual market over time. See [ADR 0011](docs/adr/0011-value-aware-identifier-comps-deferred.md).

## Stack

| Layer | Tech |
|---|---|
| Scraper | Node.js, custom HTML parser |
| Tier 0 — pre-filter | Sharp (pHash dedup, quality gate), CPU |
| Tier 1 — ranker | CLIP/SigLIP embeddings, batched, scores every survivor |
| Tier 2 — strong VLM | RunPod serverless `qwen3-vl:30b` / `Qwen3-VL-32B`, top-K images only |
| Calibration | One-time reference pass + offline `recall@K` against a labeled gold set |
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
