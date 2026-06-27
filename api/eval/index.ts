#!/usr/bin/env tsx
/**
 * Vision model eval harness.
 *
 * Ollama (local, default):
 *   npm run eval                                             # qwen2.5vl:7b-q8_0 + chat-kitsch
 *   npm run eval -- --model qwen2.5vl:7b-q8_0               # explicit model
 *   npm run eval -- --prompt chat-plain --verbose            # specific prompt + per-image output
 *   npm run eval -- --compare                                # all prompts on one model
 *   npm run eval -- --out results/qwen-q8.json              # save JSON results
 *
 * OpenAI-compatible API (Together AI, OpenRouter, Hyperbolic, etc.):
 *   EVAL_API_BASE=https://api.together.xyz \
 *   EVAL_API_KEY=your_key \
 *   npm run eval -- --model Qwen/Qwen2.5-VL-72B-Instruct --prompt chat-kitsch --verbose
 *
 *   # Or via CLI flags:
 *   npm run eval -- --api-base https://api.together.xyz --api-key sk-... \
 *                   --model Qwen/Qwen2.5-VL-72B-Instruct
 *
 * Prompt variants: legacy-baseline | legacy-current | chat-plain | chat-structured | chat-enriched | chat-kitsch
 * Note: legacy-* prompts use Ollama /api/generate and are skipped in OpenAI API mode.
 *
 * Provider notes:
 *   Together AI:  https://api.together.xyz  — ~$1.20/M tokens, pay-as-you-go
 *   OpenRouter:   https://openrouter.ai/api — aggregates cheapest provider per model
 *   Hyperbolic:   https://api.hyperbolic.xyz — ~$0.40/M tokens, smaller selection
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LabeledImage } from "./types.js";
import { prompts, getPrompt } from "./prompts.js";
import { summarize } from "./score.js";
import { printSummary, printComparison, printImageResults } from "./report.js";
import { runEval, type ApiConfig } from "./run.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5vl:7b-q8_0";
const LABELS_PATH = resolve(import.meta.dirname, "labels.json");

function parseArgs(argv: string[]): {
  model: string;
  promptName: string;
  compare: boolean;
  verbose: boolean;
  out: string | null;
  apiBase: string | null;
  apiKey: string | null;
} {
  const args = {
    model: DEFAULT_MODEL,
    promptName: "chat-kitsch",
    compare: false,
    verbose: false,
    out: null as string | null,
    apiBase: process.env.EVAL_API_BASE ?? null,
    apiKey: process.env.EVAL_API_KEY ?? null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") args.model = argv[++i]!;
    else if (arg === "--prompt") args.promptName = argv[++i]!;
    else if (arg === "--compare") args.compare = true;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--out") args.out = argv[++i]!;
    else if (arg === "--api-base") args.apiBase = argv[++i]!;
    else if (arg === "--api-key") args.apiKey = argv[++i]!;
  }

  return args;
}

function buildApiConfig(args: ReturnType<typeof parseArgs>): ApiConfig {
  if (args.apiBase) {
    if (!args.apiKey) {
      console.error("Error: --api-base requires --api-key (or EVAL_API_KEY env var)");
      process.exit(1);
    }
    return { type: "openai", base: args.apiBase.replace(/\/$/, ""), key: args.apiKey };
  }
  return { type: "ollama", host: OLLAMA_HOST };
}

function apiLabel(api: ApiConfig): string {
  return api.type === "openai" ? `OpenAI-compat  ${api.base}` : `Ollama         ${api.host}`;
}

function progress(i: number, total: number, label: LabeledImage) {
  process.stdout.write(
    `  [${i + 1}/${total}] ${label.category.padEnd(12)} ${label.notes.slice(0, 48)}\r`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const api = buildApiConfig(args);
  const labels: LabeledImage[] = JSON.parse(readFileSync(LABELS_PATH, "utf-8"));

  console.log(`\nEstate Sale Vision Eval`);
  console.log(`API:     ${apiLabel(api)}`);
  console.log(`Labels:  ${labels.length} images`);

  const summaries = [];

  if (args.compare) {
    console.log(`Model:   ${args.model} (all ${prompts.length} prompt variants)\n`);

    for (const prompt of prompts) {
      if (api.type === "openai" && prompt.legacyPrompt) {
        console.log(`Skipping ${prompt.name} — legacy generate prompts require Ollama`);
        continue;
      }
      console.log(`Running prompt: ${prompt.name} — ${prompt.description}`);
      const result = await runEval(labels, args.model, prompt, api, progress);
      console.log();
      const summary = summarize(result);
      summaries.push({ summary, result });
      printSummary(summary);
      if (args.verbose) printImageResults(result.results);
    }

    if (summaries.length > 1) printComparison(summaries.map((s) => s.summary));
  } else {
    const prompt = getPrompt(args.promptName);
    if (api.type === "openai" && prompt.legacyPrompt) {
      console.error(`Error: prompt "${prompt.name}" uses /api/generate which requires Ollama.`);
      console.error(`Use a chat-* prompt variant with the OpenAI API.`);
      process.exit(1);
    }

    console.log(`Model:   ${args.model}`);
    console.log(`Prompt:  ${prompt.name} — ${prompt.description}\n`);

    const result = await runEval(labels, args.model, prompt, api, progress);
    console.log();

    const summary = summarize(result);
    printSummary(summary);
    if (args.verbose) printImageResults(result.results);

    if (args.out) {
      writeFileSync(args.out, JSON.stringify({ summary, results: result.results }, null, 2));
      console.log(`\nResults saved to ${args.out}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
