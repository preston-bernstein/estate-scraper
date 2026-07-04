import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { findings, images, sales } from "../../db/schema.js";

// Integration tests against a real migrated SQLite db (mirrors scan/__tests__/persist.test.ts)
// because this feature's correctness lives in a findings/images JOIN plus a live
// embedding-endpoint dependency — a mocked query builder would hide exactly the
// bugs (join filters, dim guards, upcoming-scope) these tests exist to catch. All
// embedding calls are MOCKED at the fetch boundary; no real endpoint is ever hit.

const EMBED_MODEL = "test-siglip-model";
const EMBED_DIM = 3;

let dir: string;
let dbPath: string;
let db: typeof import("../../db/index.js")["db"];

const V1 = [1, 0, 0]; // "armchair" image embedding
const V2 = [0, 1, 0]; // "cozy nook" (semantic-only) image embedding
const V4 = [0, 0, 1]; // stale-model image embedding — must be excluded by embedModel filter

function mockEmbedEndpoint(vec: number[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return {
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: vec }] }),
    } as Response;
  });
}

async function insertSale(overrides: Partial<typeof sales.$inferInsert>) {
  await db
    .insert(sales)
    .values({
      saleId: overrides.saleId!,
      title: "Sale",
      url: "https://example.com/sale",
      startDate: "2026-07-01",
      endDate: "2026-08-01",
      address: "1 Elm St",
      city: "Decatur",
      state: "GA",
      zip: "30030",
      lat: 33.7,
      lon: -84.3,
      distanceMiles: 3,
      scrapedAt: "2026-06-30T00:00:00Z",
      ...overrides,
    })
    .run();
}

async function insertImage(
  saleId: string,
  imageUrl: string,
  embedding: number[] | null,
  embedModel: string | null,
) {
  const { float32ToBlob } = await import("../../lib/embed.js");
  await db
    .insert(images)
    .values({
      saleId,
      imageUrl,
      embedding: embedding ? float32ToBlob(embedding) : null,
      embedModel,
      embedDim: embedding ? embedding.length : null,
    })
    .run();
  const row = await db
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.saleId, saleId), eq(images.imageUrl, imageUrl)));
  return row[0]!.id;
}

async function insertFinding(saleId: string, imageId: number | null, imageUrl: string, description: string) {
  await db
    .insert(findings)
    .values({
      saleId,
      imageId,
      imageUrl,
      description,
      scrapedAt: "2026-06-30T00:00:00Z",
      confidence: "high",
    })
    .run();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "es-semantic-search-"));
  dbPath = join(dir, "test.db");
  process.env.DATABASE_URL = dbPath;
  const dbmod = await import("../../db/index.js");
  dbmod.runMigrations("drizzle");
  db = dbmod.db;

  await insertSale({ saleId: "SALE-UP" });
  await insertSale({ saleId: "SALE-PAST", endDate: "2020-01-01" });

  const img1 = await insertImage("SALE-UP", "https://x/f1.jpg", V1, EMBED_MODEL);
  const img2 = await insertImage("SALE-UP", "https://x/f2.jpg", V2, EMBED_MODEL);
  const img3 = await insertImage("SALE-UP", "https://x/f3.jpg", null, null); // pre-backfill, no embedding
  const img4 = await insertImage("SALE-UP", "https://x/f4.jpg", V4, "stale-model-v0"); // rotated model
  const imgPast = await insertImage("SALE-PAST", "https://x/fpast.jpg", V1, EMBED_MODEL);

  await insertFinding("SALE-UP", img1, "https://x/f1.jpg", "vintage oak armchair");
  await insertFinding("SALE-UP", img2, "https://x/f2.jpg", "a comfortable place for resting your body");
  await insertFinding("SALE-UP", img3, "https://x/f3.jpg", "hand-woven rug");
  await insertFinding("SALE-UP", img4, "https://x/f4.jpg", "obsolete model item");
  await insertFinding("SALE-PAST", imgPast, "https://x/fpast.jpg", "vintage oak armchair");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function freshSearchSalesHybrid() {
  vi.resetModules();
  const mod = await import("../semanticSearch.js");
  return mod.searchSalesHybrid;
}

describe("searchSalesHybrid — disabled / graceful degradation (AC4)", () => {
  it("passes through to Phase 1 lexical when SEMANTIC_SEARCH_ENABLED is unset", async () => {
    vi.stubEnv("SEMANTIC_SEARCH_ENABLED", "");
    vi.stubEnv("EMBED_API_BASE", "");
    const searchSalesHybrid = await freshSearchSalesHybrid();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const resolved = await searchSalesHybrid("armchair");
    expect(resolved.map((s) => s.saleId)).toContain("SALE-UP");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes through to Phase 1 when SEMANTIC_SEARCH_ENABLED=true but EMBED_API_BASE is unset", async () => {
    vi.stubEnv("SEMANTIC_SEARCH_ENABLED", "true");
    vi.stubEnv("EMBED_API_BASE", "");
    const searchSalesHybrid = await freshSearchSalesHybrid();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const resolved = await searchSalesHybrid("armchair");
    expect(resolved.map((s) => s.saleId)).toContain("SALE-UP");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("searchSalesHybrid — embedding failure fallback (AC5)", () => {
  it("falls back to lexical within budget when the embed call times out", async () => {
    vi.stubEnv("SEMANTIC_SEARCH_ENABLED", "true");
    vi.stubEnv("EMBED_API_BASE", "http://embed.test");
    vi.stubEnv("EMBED_MODEL", EMBED_MODEL);
    vi.stubEnv("EMBED_SEARCH_TIMEOUT_MS", "30");
    const searchSalesHybrid = await freshSearchSalesHybrid();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });

    const start = Date.now();
    const resolved = await searchSalesHybrid("armchair");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(resolved.map((s) => s.saleId)).toContain("SALE-UP");
  });

  it("falls back to lexical when the embed endpoint errors", async () => {
    vi.stubEnv("SEMANTIC_SEARCH_ENABLED", "true");
    vi.stubEnv("EMBED_API_BASE", "http://embed.test");
    vi.stubEnv("EMBED_MODEL", EMBED_MODEL);
    const searchSalesHybrid = await freshSearchSalesHybrid();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    const resolved = await searchSalesHybrid("armchair");
    expect(resolved.map((s) => s.saleId)).toContain("SALE-UP");
  });
});

describe("searchSalesHybrid — semantic match (AC6)", () => {
  it("surfaces a Sale via semantic similarity with zero lexical overlap", async () => {
    vi.stubEnv("SEMANTIC_SEARCH_ENABLED", "true");
    vi.stubEnv("EMBED_API_BASE", "http://embed.test");
    vi.stubEnv("EMBED_MODEL", EMBED_MODEL);
    vi.stubEnv("EMBED_DIM", String(EMBED_DIM));
    const searchSalesHybrid = await freshSearchSalesHybrid();
    // The query embeds to V2 — identical to finding "f2"'s stored image embedding
    // (cosine = 1) — while sharing no words with its description or any sale text.
    mockEmbedEndpoint(V2);

    const query = "cozy nook";
    const lexicalOnlyMod = await import("../discover.js");
    const lexicalOnly = await lexicalOnlyMod.searchSales(query);
    expect(lexicalOnly).toHaveLength(0); // sanity: no lexical overlap at all

    const resolved = await searchSalesHybrid(query);
    expect(resolved.map((s) => s.saleId)).toContain("SALE-UP");
  });
});

describe("searchSalesHybrid — upcoming scope (AC9)", () => {
  it("never returns a Sale past its end date, hybrid or lexical", async () => {
    vi.stubEnv("SEMANTIC_SEARCH_ENABLED", "true");
    vi.stubEnv("EMBED_API_BASE", "http://embed.test");
    vi.stubEnv("EMBED_MODEL", EMBED_MODEL);
    vi.stubEnv("EMBED_DIM", String(EMBED_DIM));
    const searchSalesHybrid = await freshSearchSalesHybrid();
    mockEmbedEndpoint(V1);

    const resolved = await searchSalesHybrid("armchair");
    expect(resolved.map((s) => s.saleId)).not.toContain("SALE-PAST");
  });
});

describe("searchSalesHybrid — partial-embedding corpus", () => {
  it("still surfaces a Finding with a null image embedding via lexical match", async () => {
    vi.stubEnv("SEMANTIC_SEARCH_ENABLED", "true");
    vi.stubEnv("EMBED_API_BASE", "http://embed.test");
    vi.stubEnv("EMBED_MODEL", EMBED_MODEL);
    vi.stubEnv("EMBED_DIM", String(EMBED_DIM));
    const searchSalesHybrid = await freshSearchSalesHybrid();
    mockEmbedEndpoint(V1); // unrelated to "rug" finding's (null) embedding

    const resolved = await searchSalesHybrid("rug");
    expect(resolved.map((s) => s.saleId)).toContain("SALE-UP");
  });

  it("excludes a stale-embedModel row from the semantic candidate set (logged candidateRows reflects only current-model rows)", async () => {
    vi.stubEnv("SEMANTIC_SEARCH_ENABLED", "true");
    vi.stubEnv("EMBED_API_BASE", "http://embed.test");
    vi.stubEnv("EMBED_MODEL", EMBED_MODEL);
    vi.stubEnv("EMBED_DIM", String(EMBED_DIM));
    const searchSalesHybrid = await freshSearchSalesHybrid();
    mockEmbedEndpoint(V1);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await searchSalesHybrid("some query with no lexical hits at all");

    const hybridLog = errorSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("hybrid"));
    expect(hybridLog).toBeDefined();
    // Only img1 (armchair) + img2 (cozy nook) carry embeddings under EMBED_MODEL;
    // img3 is null and img4 is under a stale model — both excluded by the JOIN filter.
    expect(hybridLog).toContain("candidateRows=2");
  });
});
