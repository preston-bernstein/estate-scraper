import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "../../lib/vision.js";

// Integration test for the scan write path against a real migrated SQLite db.
// Exists because the persistence layer shipped a bug unit tests couldn't see:
// better-sqlite3 transactions must be SYNCHRONOUS, and the code used
// `db.transaction(async tx => await ...)` which throws at runtime only. These
// tests call the real persist functions and assert rows land — so a regression to
// async transactions (or any insert breakage) fails here instead of at 1am Friday.

let persist: typeof import("../persist.js");
let dir: string;
let dbPath: string;

// A second, read-only connection for assertions (the persist singleton owns writes).
function read<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const sale = {
  saleId: "TEST-1",
  title: "Test Estate Sale",
  url: "https://example.com/sale/TEST-1",
  startDate: "2026-07-01",
  endDate: "2026-07-03",
  address: "1 Test St",
  city: "Decatur",
  state: "GA",
  zip: "30033",
  lat: 33.8,
  lon: -84.26,
  distanceMiles: 5,
  imageUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg", "https://cdn/c.jpg"],
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "es-persist-"));
  dbPath = join(dir, "test.db");
  process.env.DATABASE_URL = dbPath;
  // Import after DATABASE_URL is set so the db singleton opens the temp file.
  const dbmod = await import("../../db/index.js");
  dbmod.runMigrations("drizzle"); // cwd is api/ under vitest
  persist = await import("../persist.js");
  await persist.upsertSale(sale, "2026-06-30T00:00:00Z");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("insertFindingsBatch (sync transaction regression)", () => {
  it("persists findings, image rows, and extracted items without throwing", async () => {
    await expect(
      persist.insertFindingsBatch(
        sale.saleId,
        [
          { imageUrl: "https://cdn/a.jpg", description: "Stickley oak armchair", confidence: "high", imagePositionPct: 0 },
          { imageUrl: "https://cdn/b.jpg", description: "walnut mid-century credenza", confidence: "medium", imagePositionPct: 0.5 },
        ],
        "2026-06-30T00:00:00Z",
      ),
    ).resolves.not.toThrow();

    const counts = read((db) => ({
      findings: db.prepare("select count(*) c from findings").get() as { c: number },
      images: db.prepare("select count(*) c from images").get() as { c: number },
      items: db.prepare("select count(*) c from finding_items").get() as { c: number },
    }));
    expect(counts.findings.c).toBe(2);
    expect(counts.images.c).toBe(2); // one image row per finding
    expect(counts.items.c).toBe(2); // one item per single-line description

    // Lexicon resolved the maker; provenance stamped.
    const stickley = read((db) =>
      db.prepare("select maker, source, vlm_model, prompt_version from finding_items where item_desc=?")
        .get("Stickley oak armchair") as Record<string, unknown>,
    );
    expect(stickley.maker).toBe("Stickley");
    expect(stickley.source).toBe("lexicon");
    expect(stickley.prompt_version).toBe(PROMPT_VERSION);
  });

  // UNIQUE(sale_id, image_url) makes re-running the batch a no-op: the finding
  // conflicts (DO NOTHING) and its items aren't regenerated. The upstream skip-set
  // avoids the wasted vision work; this is the durable DB-level guard.
  it("is idempotent on re-run (UNIQUE(sale_id,image_url) → no dup finding/items)", async () => {
    const before = read((db) => ({
      findings: (db.prepare("select count(*) c from findings").get() as { c: number }).c,
      items: (db.prepare("select count(*) c from finding_items").get() as { c: number }).c,
    }));
    await persist.insertFindingsBatch(
      sale.saleId,
      [{ imageUrl: "https://cdn/a.jpg", description: "Stickley oak armchair", confidence: "high", imagePositionPct: 0 }],
      "2026-06-30T00:00:00Z",
    );
    const after = read((db) => ({
      findings: (db.prepare("select count(*) c from findings").get() as { c: number }).c,
      items: (db.prepare("select count(*) c from finding_items").get() as { c: number }).c,
    }));
    expect(after).toEqual(before); // re-run inserted nothing
  });
});

describe("upsertAnalyzedImages", () => {
  it("persists every analyzed image with phash + thumbnail, idempotently", async () => {
    await persist.upsertAnalyzedImages(sale.saleId, [
      { imageUrl: "https://cdn/c.jpg", phash: "00ff00ff00ff00ff", positionPct: 1, thumbnailPath: "/t/c.jpg", visionResponse: null },
    ]);
    let row = read((db) =>
      db.prepare("select phash, thumbnail_path from images where image_url=?").get("https://cdn/c.jpg") as Record<string, unknown>,
    );
    expect(row.phash).toBe("00ff00ff00ff00ff");
    expect(row.thumbnail_path).toBe("/t/c.jpg");

    // Re-run with a null phash must NOT clobber the existing one (coalesce guard).
    await persist.upsertAnalyzedImages(sale.saleId, [
      { imageUrl: "https://cdn/c.jpg", phash: null, positionPct: 1, thumbnailPath: null, visionResponse: null },
    ]);
    row = read((db) =>
      db.prepare("select phash, thumbnail_path from images where image_url=?").get("https://cdn/c.jpg") as Record<string, unknown>,
    );
    expect(row.phash).toBe("00ff00ff00ff00ff");
    expect(row.thumbnail_path).toBe("/t/c.jpg");

    const imgCount = read((db) => (db.prepare("select count(*) c from images where image_url=?").get("https://cdn/c.jpg") as { c: number }).c);
    expect(imgCount).toBe(1); // UNIQUE(sale_id, image_url) — no duplicate
  });
});

describe("getProcessedImageUrls", () => {
  it("returns the skip-set from the images table (every analyzed photo)", async () => {
    const urls = await persist.getProcessedImageUrls();
    // a.jpg + b.jpg (from findings) + c.jpg (analyzed-only) all present
    expect(urls.has("https://cdn/a.jpg")).toBe(true);
    expect(urls.has("https://cdn/c.jpg")).toBe(true);
  });
});
