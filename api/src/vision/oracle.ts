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

// Pull the first balanced-looking JSON object out of a model completion, tolerating
// ```json fences and leading/trailing prose. Returns null if none is found.
function extractJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
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

  const imageContent = buffers.map((b) => ({
    type: "image_url" as const,
    image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}` },
  }));

  let response: Response;
  try {
    response = await fetch(`${ORACLE_API_BASE}/v1/chat/completions`, {
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
  } catch (err) {
    console.error("[oracle] fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }

  if (!response.ok) {
    console.error(`[oracle] HTTP ${response.status}`);
    return null;
  }

  try {
    // Third-party VLM response — shape is not guaranteed.
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
    // Models wrap JSON in ```json fences even at temp 0.1 with "JSON only" — strip
    // fences / pull the first {...} block before parsing, else a valid verdict is
    // silently dropped for exactly the uncertain-zone sales the oracle exists for.
    const jsonText = extractJsonBlock(text);
    if (!jsonText) {
      console.error("[oracle] no JSON object in response");
      return null;
    }
    const parsed = JSON.parse(jsonText) as Partial<OracleResult>;
    const score = Number(parsed.score);
    // Reject a non-numeric / out-of-range score rather than storing NaN (→ NULL in
    // SQLite), which would leave oracle_score diverged from oracle_verdict.
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      console.error(`[oracle] invalid score: ${parsed.score}`);
      return null;
    }
    return {
      score,
      topItems: Array.isArray(parsed.topItems) ? parsed.topItems : [],
      shouldAttend: Boolean(parsed.shouldAttend),
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    console.error("[oracle] failed to parse response");
    return null;
  }
}
