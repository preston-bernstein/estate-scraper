import {
  ORACLE_API_BASE,
  ORACLE_API_KEY,
  ORACLE_MODEL,
} from "../lib/sampling.js";
import { fetchBuffer } from "../lib/http.js";

export type OracleResult = {
  score: number;       // 1–5
  topItems: string[];
  shouldAttend: boolean;
  reasoning: string;
};

const ORACLE_SYSTEM =
  "You are evaluating estate sale listings for a collector who buys quality furniture, vintage electronics, " +
  "and kitsch/camp items. Rate the sale based on the photos provided.";

const ORACLE_USER_TEMPLATE = (title: string, address: string) =>
  `Sale: "${title}" at ${address}\n\n` +
  "Review these photos and rate this estate sale 1–5 for the collector described. " +
  "Return JSON only, no other text:\n" +
  '{ "score": 1-5, "topItems": ["item1", "item2"], "shouldAttend": true/false, "reasoning": "one sentence" }';

// Detect Anthropic native API vs OpenAI-compatible (OpenRouter, RunPod, Gemini, etc.)
const isAnthropic = ORACLE_API_BASE.includes("api.anthropic.com");

async function callOracleAnthropic(
  title: string,
  address: string,
  buffers: Buffer[],
): Promise<Response> {
  const imageContent = buffers.map((b) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/jpeg" as const, data: b.toString("base64") },
  }));

  return fetch(`${ORACLE_API_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ORACLE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ORACLE_MODEL,
      max_tokens: 256,
      temperature: 0.1,
      system: ORACLE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: ORACLE_USER_TEMPLATE(title, address) },
            ...imageContent,
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
}

async function callOracleOpenAI(
  title: string,
  address: string,
  buffers: Buffer[],
): Promise<Response> {
  const imageContent = buffers.map((b) => ({
    type: "image_url" as const,
    image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}` },
  }));

  return fetch(`${ORACLE_API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ORACLE_API_KEY}`,
    },
    body: JSON.stringify({
      model: ORACLE_MODEL,
      messages: [
        { role: "system", content: ORACLE_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: ORACLE_USER_TEMPLATE(title, address) },
            ...imageContent,
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 256,
    }),
    signal: AbortSignal.timeout(120_000),
  });
}

function extractText(payload: unknown): string {
  if (isAnthropic) {
    const p = payload as { content?: Array<{ type: string; text?: string }> };
    return p.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
  }
  const p = payload as { choices?: Array<{ message?: { content?: string } }> };
  return p.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function callOracle(
  title: string,
  address: string,
  imageUrls: string[],
): Promise<OracleResult | null> {
  if (!ORACLE_API_BASE || !ORACLE_API_KEY || !ORACLE_MODEL) return null;

  const buffers = (
    await Promise.all(imageUrls.slice(0, 6).map((url) => fetchBuffer(url)))
  ).filter((b): b is Buffer => b !== null);

  if (buffers.length === 0) return null;

  let response: Response;
  try {
    response = isAnthropic
      ? await callOracleAnthropic(title, address, buffers)
      : await callOracleOpenAI(title, address, buffers);
  } catch (err) {
    console.error("[oracle] fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }

  if (!response.ok) {
    console.error(`[oracle] HTTP ${response.status}`);
    return null;
  }

  try {
    const text = extractText(await response.json());
    const parsed = JSON.parse(text) as Partial<OracleResult>;
    return {
      score: Number(parsed.score ?? 0),
      topItems: Array.isArray(parsed.topItems) ? parsed.topItems : [],
      shouldAttend: Boolean(parsed.shouldAttend),
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    console.error("[oracle] failed to parse response");
    return null;
  }
}
