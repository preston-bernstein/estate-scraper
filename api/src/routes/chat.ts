import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OLLAMA_HOST } from "../lib/vision.js";
import type { AppEnv } from "../types/env.js";
import { getRecentFindingsContext } from "../services/discover.js";

const CHAT_MODEL = process.env.CHAT_MODEL ?? "qwen3:30b-a3b";

export const chatRoutes = new Hono<AppEnv>();

const MAX_MESSAGE_LENGTH = 4000;

chatRoutes.post("/", async (c) => {
  const body = await c.req.json<{
    message?: unknown;
    history?: Array<{ role?: unknown; content?: unknown }>;
  }>();

  if (typeof body.message !== "string" || !body.message.trim()) {
    return c.json({ error: "message is required" }, 400);
  }
  if (body.message.length > MAX_MESSAGE_LENGTH) {
    return c.json({ error: `message must be under ${MAX_MESSAGE_LENGTH} characters` }, 400);
  }
  const message = body.message;

  const history = (body.history ?? []).filter(
    (h): h is { role: "user" | "assistant"; content: string } =>
      (h.role === "user" || h.role === "assistant") && typeof h.content === "string",
  );

  const context = await getRecentFindingsContext();

  const systemPrompt =
    "You are a sharp, opinionated estate sale curator in Atlanta, GA. " +
    "You help buyers find things worth attending a sale for: quality furniture, vintage electronics, " +
    "kitsch and camp collectibles (velvet paintings, ceramic novelties, taxidermy), " +
    "named-brand pieces, and anything genuinely interesting. " +
    "You are concise, specific, and have good taste. You reference actual items from the findings below. " +
    "When listing items, be brief — one line per item, no bullet noise. " +
    "If asked about something not in the findings, say so directly.\n\n" +
    "CURRENT ESTATE SALE FINDINGS:\n" + context;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: message },
  ];

  return streamSSE(c, async (stream) => {
    try {
      const ollamaRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages,
          stream: true,
          options: { temperature: 0.7 },
          think: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!ollamaRes.ok || !ollamaRes.body) {
        await stream.writeSSE({ data: JSON.stringify({ error: `Ollama error: ${ollamaRes.status}` }) });
        return;
      }

      const reader = ollamaRes.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
            };
            const token = chunk.message?.content ?? "";
            if (token) {
              await stream.writeSSE({ data: JSON.stringify({ token }) });
            }
            if (chunk.done) {
              await stream.writeSSE({ data: JSON.stringify({ done: true }) });
              return;
            }
          } catch {
            // partial JSON line — skip
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await stream.writeSSE({ data: JSON.stringify({ error: msg }) });
    }
  });
});
