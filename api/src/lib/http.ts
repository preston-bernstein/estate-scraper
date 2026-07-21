import { FETCH_HEADERS } from "./scraping.js";
import { fetchPageHtml } from "./stealth-sidecar/session.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchText(url: string): Promise<string | null> {
  return fetchPageHtml(url);
}

export async function politeDelay(minMs = 1200, maxMs = 3500): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  await sleep(delay);
}

export async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}
