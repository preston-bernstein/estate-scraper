import { FETCH_HEADERS } from "./constants.js";
import { sleep } from "./geo.js";

export async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.error(`  [error] ${url}: HTTP ${response.status}`);
      return null;
    }

    return response.text();
  } catch (error) {
    console.error(`  [error] ${url}:`, error);
    return null;
  }
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
