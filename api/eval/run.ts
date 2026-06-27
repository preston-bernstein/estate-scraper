import type { ImageResult, LabeledImage, ModelPromptResult } from "./types.js";
import type { PromptVariant } from "./prompts.js";
import { scoreResult } from "./score.js";

// Ollama: calls /api/chat or /api/generate on a local Ollama instance.
// OpenAI: calls /v1/chat/completions on any OpenAI-compatible API
//   (Together AI, OpenRouter, Hyperbolic, etc.). Legacy generate prompts
//   are Ollama-only and will be skipped with a warning in openai mode.
export type ApiConfig =
  | { type: "ollama"; host: string }
  | { type: "openai"; base: string; key: string };

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.estatesales.net/",
};

// JSON schema for Ollama's structured output (legacy chat-structured variant).
const VISION_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          category: {
            type: "string",
            enum: ["seating", "bed", "case_goods", "collectible", "decor", "other"],
          },
        },
        required: ["description", "category"],
      },
    },
  },
  required: ["items"],
};

async function fetchImageData(url: string): Promise<{ base64: string; mimeType: string }> {
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
  return { base64, mimeType };
}

function parseStructuredResponse(content: string): string {
  try {
    const parsed = JSON.parse(content.trim()) as { items?: Array<{ description: string }> };
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return "NOTHING";
    return parsed.items.map((item) => item.description.trim()).filter(Boolean).join("\n");
  } catch {
    return content.trim();
  }
}

async function callOllamaChat(
  host: string,
  model: string,
  prompt: PromptVariant,
  imageBase64: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: prompt.systemPrompt ?? "" },
      { role: "user", content: prompt.userPrompt ?? "", images: [imageBase64] },
    ],
    stream: false,
    options: { temperature: 0.1 },
  };
  if (prompt.structuredOutput) body.format = VISION_SCHEMA;

  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Ollama /api/chat error: HTTP ${response.status}`);

  const payload = (await response.json()) as { message?: { content?: string } };
  const content = payload.message?.content ?? "";
  return prompt.structuredOutput ? parseStructuredResponse(content) : content.trim();
}

async function callOllamaGenerate(
  host: string,
  model: string,
  legacyPrompt: string,
  imageBase64: string,
): Promise<string> {
  const response = await fetch(`${host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: legacyPrompt,
      images: [imageBase64],
      stream: false,
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Ollama /api/generate error: HTTP ${response.status}`);

  const payload = (await response.json()) as { response?: string };
  return payload.response?.trim() ?? "";
}

async function callOpenAI(
  config: Extract<ApiConfig, { type: "openai" }>,
  model: string,
  prompt: PromptVariant,
  imageBase64: string,
  mimeType: string,
): Promise<string> {
  const response = await fetch(`${config.base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: prompt.systemPrompt ?? "" },
        {
          role: "user",
          content: [
            { type: "text", text: prompt.userPrompt ?? "" },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI API error: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content?.trim() ?? "";
}

// Retries once on transient 500 (model load spike) or 429 (rate limit).
async function callWithRetry(
  fn: () => Promise<string>,
  retries = 1,
  delayMs = 3000,
): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isRetryable = msg.includes("HTTP 500") || msg.includes("HTTP 429");
      const delay = msg.includes("HTTP 429") ? 10_000 : delayMs;
      if (attempt < retries && isRetryable) {
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

export async function runEval(
  labels: LabeledImage[],
  model: string,
  prompt: PromptVariant,
  api: ApiConfig,
  onProgress?: (i: number, total: number, label: LabeledImage) => void,
): Promise<ModelPromptResult> {
  const results: ImageResult[] = [];

  for (const [i, label] of labels.entries()) {
    onProgress?.(i, labels.length, label);

    const started = Date.now();
    let raw = "";
    let error: string | null = null;

    try {
      if (api.type === "openai" && prompt.legacyPrompt) {
        // Legacy generate prompts use Ollama's /api/generate — no OpenAI equivalent.
        throw new Error("legacy prompts require Ollama; skipping for OpenAI API");
      }

      const { base64, mimeType } = await fetchImageData(label.url);

      let call: () => Promise<string>;
      if (api.type === "openai") {
        call = () => callOpenAI(api, model, prompt, base64, mimeType);
      } else if (prompt.legacyPrompt) {
        call = () => callOllamaGenerate(api.host, model, prompt.legacyPrompt!, base64);
      } else {
        call = () => callOllamaChat(api.host, model, prompt, base64);
      }

      raw = await callWithRetry(call);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    results.push(scoreResult(label, raw, Date.now() - started, error));
  }

  return { model, promptName: prompt.name, results };
}
