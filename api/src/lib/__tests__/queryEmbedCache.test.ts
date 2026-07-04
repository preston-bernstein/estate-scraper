import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// embedQueryText is mocked at the module boundary so these tests exercise only
// the cache's own hit/miss/TTL/LRU logic, with a call-count assertion standing
// in for "did we actually re-embed" (AC7, AC18).
const embedQueryText = vi.fn(async (text: string) => [text.length]);
vi.mock("../embed.js", () => ({
  embedQueryText: (text: string) => embedQueryText(text),
}));

let getCachedQueryEmbedding: typeof import("../queryEmbedCache.js")["getCachedQueryEmbedding"];

beforeEach(async () => {
  vi.resetModules();
  embedQueryText.mockClear();
  ({ getCachedQueryEmbedding } = await import("../queryEmbedCache.js"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getCachedQueryEmbedding", () => {
  it("embeds a novel query exactly once", async () => {
    const vec = await getCachedQueryEmbedding("couch");
    expect(vec).toEqual([5]);
    expect(embedQueryText).toHaveBeenCalledTimes(1);
  });

  it("a repeated identical query within the TTL does not re-embed (AC7)", async () => {
    await getCachedQueryEmbedding("couch");
    await getCachedQueryEmbedding("couch");
    await getCachedQueryEmbedding("  Couch  "); // normalized the same way
    expect(embedQueryText).toHaveBeenCalledTimes(1);
  });

  it("returns null and does not cache when embedQueryText returns null", async () => {
    embedQueryText.mockResolvedValueOnce(null as unknown as number[]);
    const vec = await getCachedQueryEmbedding("no-vector");
    expect(vec).toBeNull();
    await getCachedQueryEmbedding("no-vector");
    expect(embedQueryText).toHaveBeenCalledTimes(2); // nothing cached, re-tried
  });

  it("returns null and never throws when embedQueryText throws unexpectedly", async () => {
    embedQueryText.mockRejectedValueOnce(new Error("boom"));
    await expect(getCachedQueryEmbedding("explodes")).resolves.toBeNull();
  });

  it("returns null for an empty/whitespace-only query without calling embedQueryText", async () => {
    const vec = await getCachedQueryEmbedding("   ");
    expect(vec).toBeNull();
    expect(embedQueryText).not.toHaveBeenCalled();
  });

  it("re-embeds after the 5-minute TTL expires", async () => {
    vi.useFakeTimers();
    try {
      await getCachedQueryEmbedding("chair");
      expect(embedQueryText).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(4 * 60 * 1000); // within TTL
      await getCachedQueryEmbedding("chair");
      expect(embedQueryText).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2 * 60 * 1000); // now past the 5-minute TTL
      await getCachedQueryEmbedding("chair");
      expect(embedQueryText).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a true LRU: a cache hit moves the entry so eviction hits the actual least-recently-used", async () => {
    // Fill the cache to its 512-entry cap with q0..q511, all cached.
    for (let i = 0; i < 512; i++) {
      await getCachedQueryEmbedding(`q${i}`);
    }
    embedQueryText.mockClear();

    // Touch q0 (a hit) so it becomes most-recently-used, then insert one more
    // unique query. FIFO would evict q0; true LRU evicts q1 instead.
    await getCachedQueryEmbedding("q0");
    expect(embedQueryText).not.toHaveBeenCalled(); // q0 was a cache hit

    await getCachedQueryEmbedding("q512"); // 513th unique key -> evicts LRU

    embedQueryText.mockClear();
    await getCachedQueryEmbedding("q0"); // still cached (was touched) -> no re-embed
    expect(embedQueryText).not.toHaveBeenCalled();

    await getCachedQueryEmbedding("q1"); // was the true LRU -> evicted -> re-embeds
    expect(embedQueryText).toHaveBeenCalledTimes(1);
  });

  it("enforces the 512-entry cap: the 513th unique query evicts the least-recently-used", async () => {
    for (let i = 0; i < 513; i++) {
      await getCachedQueryEmbedding(`u${i}`);
    }
    embedQueryText.mockClear();

    await getCachedQueryEmbedding("u0"); // evicted (cap exceeded) -> re-embeds
    expect(embedQueryText).toHaveBeenCalledTimes(1);

    embedQueryText.mockClear();
    await getCachedQueryEmbedding("u512"); // most recent -> still cached
    expect(embedQueryText).not.toHaveBeenCalled();
  });
});
