import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Integration test for Phase 1 semantic-search query expansion (docs/semantic-search)
// against a real migrated SQLite db, following the pattern in
// api/src/scan/__tests__/persist.test.ts: a temp file DB, migrated once, seeded with
// sales/findings/finding_items, then exercised through the real searchSales().

let discover: typeof import("../discover.js");
let dir: string;
let dbPath: string;
let db: Database.Database;

function insertSale(s: {
  saleId: string;
  title: string;
  city: string;
  state: string;
  address: string;
  endDate: string;
  distanceMiles?: number;
}) {
  db.prepare(
    `insert into sales
      (sale_id, title, url, start_date, end_date, address, city, state, zip, lat, lon, distance_miles, scraped_at)
     values (@saleId, @title, @url, @startDate, @endDate, @address, @city, @state, @zip, @lat, @lon, @distanceMiles, @scrapedAt)`,
  ).run({
    saleId: s.saleId,
    title: s.title,
    url: `https://example.com/sale/${s.saleId}`,
    startDate: "2026-01-01",
    endDate: s.endDate,
    address: s.address,
    city: s.city,
    state: s.state,
    zip: "30000",
    lat: 33.0,
    lon: -84.0,
    distanceMiles: s.distanceMiles ?? 5,
    scrapedAt: "2026-01-01T00:00:00Z",
  });
}

let findingIdSeq = 0;
function insertFinding(saleId: string, description: string, category?: string): number {
  findingIdSeq += 1;
  const imageUrl = `https://cdn/${saleId}-${findingIdSeq}.jpg`;
  const info = db
    .prepare(
      `insert into findings (sale_id, image_url, description, scraped_at)
       values (?, ?, ?, ?)`,
    )
    .run(saleId, imageUrl, description, "2026-01-01T00:00:00Z");
  const findingId = Number(info.lastInsertRowid);

  if (category) {
    db.prepare(
      `insert into finding_items
        (finding_id, sale_id, category, desirability, matched_lexicon, item_desc, source, id_confidence)
       values (?, ?, ?, 'med', '[]', ?, 'vlm', 'med')`,
    ).run(findingId, saleId, category, description);
  }

  return findingId;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "es-discover-"));
  dbPath = join(dir, "test.db");
  process.env.DATABASE_URL = dbPath;
  const dbmod = await import("../../db/index.js");
  dbmod.runMigrations("drizzle"); // cwd is api/ under vitest
  discover = await import("../discover.js");
  db = new Database(dbPath);

  // Sale A: literal + synonym matches for "couch".
  insertSale({ saleId: "SALE-A", title: "Maple Street Estate Sale", city: "Decatur", state: "GA", address: "1 Maple St", endDate: "2099-01-01" });
  insertFinding("SALE-A", "mid-century sofa", "seating"); // AC1
  insertFinding("SALE-A", "vintage chaise lounge", "seating"); // AC2
  insertFinding("SALE-A", "brown loveseat", "seating"); // AC2
  insertFinding("SALE-A", "grey sectional", "seating"); // AC2

  // Sale B: a Finding matchable ONLY via finding_items.category (no literal/synonym
  // text overlap with any term "couch" expands to) — the category-only path (AC3).
  insertSale({ saleId: "SALE-B", title: "Oak Hill Sale", city: "Avondale", state: "GA", address: "2 Oak Hill Rd", endDate: "2099-01-01" });
  insertFinding("SALE-B", "primitive splint-bottom perch", "seating"); // category-only

  // Sale C: outside the upcoming window — must be excluded regardless of match (AC9).
  insertSale({ saleId: "SALE-C", title: "Expired Sale With Couch", city: "Decatur", state: "GA", address: "3 Past Ave", endDate: "2020-01-01" });
  insertFinding("SALE-C", "mid-century sofa", "seating");

  // Sale D: matches only via sale-level title/city text, no item overlap at all —
  // regression check that sale-text matching still works (AC10).
  insertSale({ saleId: "SALE-D", title: "Springfield Neighborhood Sale", city: "Springfield", state: "GA", address: "4 Elm St", endDate: "2099-01-01" });
  insertFinding("SALE-D", "box of assorted garden hoses", "other");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("searchSales — Phase 1 thesaurus expansion", () => {
  it("AC1: 'couch' matches a Finding described as 'sofa'", async () => {
    const results = await discover.searchSales("couch");
    const saleA = results.find((r) => r.saleId === "SALE-A");
    expect(saleA).toBeDefined();
    expect(saleA!.topFindings.some((f) => f.description.includes("sofa"))).toBe(true);
  });

  it("AC2: 'couch' also surfaces chaise lounge / loveseat / sectional Findings", async () => {
    const results = await discover.searchSales("couch");
    const saleA = results.find((r) => r.saleId === "SALE-A")!;
    const descs = saleA.topFindings.map((f) => f.description);
    expect(descs.some((d) => d.includes("chaise lounge"))).toBe(true);
    expect(descs.some((d) => d.includes("loveseat"))).toBe(true);
    expect(descs.some((d) => d.includes("sectional"))).toBe(true);
  });

  it("AC3: a finding_items.category='seating' row surfaces via category-only match even with no text overlap", async () => {
    const results = await discover.searchSales("couch");
    const saleB = results.find((r) => r.saleId === "SALE-B");
    expect(saleB).toBeDefined();
    expect(saleB!.topFindings.some((f) => f.description.includes("perch"))).toBe(true);
  });

  it("AC9: a sale with end_date < today is excluded from results", async () => {
    const results = await discover.searchSales("couch");
    expect(results.find((r) => r.saleId === "SALE-C")).toBeUndefined();
  });

  it("AC10 regression: a title/city text match still returns its sale", async () => {
    const results = await discover.searchSales("springfield");
    expect(results.find((r) => r.saleId === "SALE-D")).toBeDefined();
  });

  it("AC12: identical query twice returns identical ordered results", async () => {
    const first = await discover.searchSales("couch");
    const second = await discover.searchSales("couch");
    expect(second.map((r) => r.saleId)).toEqual(first.map((r) => r.saleId));
    expect(second).toEqual(first);
  });

  it("weights literal matches above category-only matches, pinning result order", async () => {
    // SALE-A has 4 literal/synonym hits (score 40+), SALE-B has 1 category-only hit
    // (score 3) — SALE-A must rank strictly above SALE-B, and the exact ids/order at
    // the top of the list must be pinned, not just "both present somewhere."
    const results = await discover.searchSales("couch");
    const ids = results.map((r) => r.saleId);
    expect(ids.indexOf("SALE-A")).toBeLessThan(ids.indexOf("SALE-B"));

    const saleA = results.find((r) => r.saleId === "SALE-A")!;
    const saleB = results.find((r) => r.saleId === "SALE-B")!;
    expect(saleA.score).toBeGreaterThan(saleB.score);
    expect(saleB.score).toBeGreaterThan(0); // category-only match still contributes
  });

  it("returns no-op empty results for an empty/whitespace query without throwing", async () => {
    await expect(discover.searchSales("")).resolves.toEqual([]);
    await expect(discover.searchSales("   ")).resolves.toEqual([]);
  });
});
