// In-process query-embedding cache (Phase 2 hybrid search, FR10/FR19). Keyed by
// normalized query text; a TRUE LRU (re-inserted on every hit, not just on
// insert — a prior FIFO draft was corrected here) with a 5-minute TTL and a hard
// 512-entry cap. Bounds both per-search embedding-API cost (repeat/identical
// queries within the TTL window never re-embed) and process memory (a long
// session can't grow the map unbounded). Never throws — wraps embedQueryText in
// try/catch so a caller can always treat a failure as "no semantic vector,
// fall back to lexical" rather than an exception to handle.

import { embedQueryText } from "./embed.js";

type CacheEntry = { vec: number[]; expiresAt: number };

const CACHE_MAX_ENTRIES = 512;
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

function normalize(query: string): string {
  return query.trim().toLowerCase();
}

function evictOverflow(): void {
  while (cache.size > CACHE_MAX_ENTRIES) {
    // Map iteration order is insertion order; the first key is the
    // least-recently-used entry because every hit re-inserts (see below).
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export async function getCachedQueryEmbedding(query: string): Promise<number[] | null> {
  const key = normalize(query);
  if (key.length === 0) return null;

  const now = Date.now();
  const existing = cache.get(key);
  if (existing) {
    if (existing.expiresAt > now) {
      // True LRU: delete + re-insert moves this entry to the "most recently
      // used" end of the Map's insertion-order iteration.
      cache.delete(key);
      cache.set(key, existing);
      return existing.vec;
    }
    cache.delete(key); // expired — fall through and re-embed
  }

  try {
    const vec = await embedQueryText(query);
    if (!vec) return null;
    cache.set(key, { vec, expiresAt: now + TTL_MS });
    evictOverflow();
    return vec;
  } catch {
    // embedQueryText already fails open (returns null), but guard against any
    // unexpected throw from a future change so this cache never surfaces one.
    return null;
  }
}
