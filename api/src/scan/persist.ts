import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { findingItems, findings, images, sales, userSettings } from "../db/schema.js";
import { extractItems, type ItemDraft } from "../lib/items.js";
import { DEFAULT_RADIUS_MILES } from "../lib/scraping.js";
import { PROMPT_VERSION, activeVlmModel } from "../lib/vision.js";
import type { AnalysisPhase, Confidence } from "../vision/index.js";
import type { ScrapedSale } from "../scraper/index.js";
import { DEV_USER_SUB } from "../types/env.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Build finding_items rows for one finding, stamped with the generator provenance
// (ADR 0016). Shared by the live scan path and the backfill so both produce
// identical rows. The lexicon is the sole authority for `maker` (ADR 0014).
function itemRowsFor(
  findingId: number,
  saleId: string,
  drafts: ItemDraft[],
  vlmModel: string | null,
  promptVersion: string | null,
) {
  return drafts.map((d) => ({
    findingId,
    saleId,
    maker: d.maker,
    makerRaw: d.makerRaw,
    category: d.category,
    era: d.era,
    desirability: d.desirability,
    matchedLexicon: d.matchedLexicon,
    itemDesc: d.itemDesc,
    source: d.source,
    idConfidence: d.idConfidence,
    vlmModel,
    promptVersion,
  }));
}

// Synchronous: runs inside a better-sqlite3 transaction, which rejects any callback
// that returns a promise. Use .run() rather than awaiting the query builder.
function insertFindingItems(
  tx: Tx,
  findingId: number,
  saleId: string,
  description: string,
  confidence: Confidence | null,
  vlmModel: string | null,
  promptVersion: string | null,
): void {
  const drafts = extractItems({ description, confidence });
  if (drafts.length === 0) return;
  tx.insert(findingItems).values(itemRowsFor(findingId, saleId, drafts, vlmModel, promptVersion)).run();
}

// Skip-set for incremental scans: every photo already ANALYZED, sourced from the
// images table (winners AND junk), not just findings. Sourcing from findings would
// re-analyze every no-finding image on each run — defeating multi-night incremental
// scans where each night should only process newly posted images.
export async function getProcessedImageUrls(): Promise<Set<string>> {
  const rows = await db.select({ imageUrl: images.imageUrl }).from(images);
  return new Set(rows.map((row) => row.imageUrl));
}

// Insert-or-get the durable Image row for an analyzed photo (ADR 0014).
// UNIQUE(sale_id, image_url) gives scan idempotency: a re-scanned sale links to the
// existing row instead of duplicating it. embedding/phash/thumbnail are filled by the
// vision pipeline (TODO) — null here keeps existing behavior non-breaking.
function upsertImage(
  tx: Tx,
  saleId: string,
  imageUrl: string,
  positionPct: number | null,
): number {
  tx.insert(images).values({ saleId, imageUrl, positionPct }).onConflictDoNothing().run();
  const row = tx
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.saleId, saleId), eq(images.imageUrl, imageUrl)))
    .get();
  return row!.id;
}

export async function upsertSale(sale: ScrapedSale, scrapedAt: string) {
  await db
    .insert(sales)
    .values({
      saleId: sale.saleId,
      title: sale.title,
      url: sale.url,
      startDate: sale.startDate,
      endDate: sale.endDate,
      address: sale.address,
      city: sale.city,
      state: sale.state,
      zip: sale.zip,
      lat: sale.lat,
      lon: sale.lon,
      distanceMiles: sale.distanceMiles,
      scrapedAt,
      imageCount: sale.imageUrls.length,
    })
    .onConflictDoNothing();
}

export async function updateSaleAnalysis(
  saleId: string,
  imagesAnalyzed: number,
  analysisPhase: AnalysisPhase,
) {
  await db
    .update(sales)
    .set({ imagesAnalyzed, analysisPhase })
    .where(eq(sales.saleId, saleId));
}

export async function updateSaleOracle(
  saleId: string,
  oracleScore: number,
  oracleVerdict: string,
  oracleShouldAttend: boolean,
  oracleTopItems: string[],
) {
  await db
    .update(sales)
    .set({
      oracleScore,
      oracleVerdict,
      oracleShouldAttend,
      oracleTopItems: JSON.stringify(oracleTopItems),
    })
    .where(eq(sales.saleId, saleId));
}

// Legacy single-insert for the import tool (no confidence/position data).
export async function insertFinding(
  saleId: string,
  imageUrl: string,
  description: string,
  scrapedAt: string,
): Promise<void> {
  db.transaction((tx) => {
    const imageId = upsertImage(tx, saleId, imageUrl, null);
    const inserted = tx
      .insert(findings)
      .values({ saleId, imageId, imageUrl, description, scrapedAt })
      .onConflictDoNothing()
      .returning({ id: findings.id })
      .get();
    // Legacy import path: no model/confidence known, so items get null provenance.
    if (inserted) insertFindingItems(tx, inserted.id, saleId, description, null, null, null);
  });
}

export async function insertFindingsBatch(
  saleId: string,
  batch: Array<{
    imageUrl: string;
    description: string;
    confidence: Confidence | null;
    imagePositionPct: number;
  }>,
  scrapedAt: string,
): Promise<void> {
  if (batch.length === 0) return;
  const vlmModel = activeVlmModel();
  db.transaction((tx) => {
    for (const f of batch) {
      const imageId = upsertImage(tx, saleId, f.imageUrl, f.imagePositionPct);
      const inserted = tx
        .insert(findings)
        .values({
          saleId,
          imageId,
          imageUrl: f.imageUrl,
          description: f.description,
          scrapedAt,
          confidence: f.confidence,
          imagePositionPct: f.imagePositionPct,
          vlmModel,
          promptVersion: PROMPT_VERSION,
        })
        .onConflictDoNothing()
        .returning({ id: findings.id })
        .get();
      // Idempotency is enforced UPSTREAM by the skip-set (getProcessedImageUrls): the
      // scan stream filters already-analyzed image URLs before this runs, so a finding
      // is inserted once. findings has no UNIQUE(sale_id, image_url), so the
      // onConflictDoNothing above is belt-and-suspenders, not the real guard.
      if (inserted) {
        insertFindingItems(
          tx,
          inserted.id,
          saleId,
          f.description,
          f.confidence,
          vlmModel,
          PROMPT_VERSION,
        );
      }
    }
  });
}

// Persist every analyzed photo — winners AND junk (ADR 0014) — with its dedup
// fingerprint and listing position. UNIQUE(sale_id, image_url) makes re-scans
// idempotent; on conflict we refresh phash/position so the backfilled finding-only
// rows (phash NULL) get their fingerprint filled the next time the sale is scanned.
export async function upsertAnalyzedImages(
  saleId: string,
  imgs: Array<{
    imageUrl: string;
    phash: string | null;
    positionPct: number;
    thumbnailPath: string | null;
  }>,
): Promise<void> {
  if (imgs.length === 0) return;
  db.transaction((tx) => {
    for (const img of imgs) {
      tx
        .insert(images)
        .values({
          saleId,
          imageUrl: img.imageUrl,
          phash: img.phash,
          positionPct: img.positionPct,
          thumbnailPath: img.thumbnailPath,
        })
        .onConflictDoUpdate({
          target: [images.saleId, images.imageUrl],
          // coalesce(new, existing): a failed re-scan write (null) must never clobber
          // a phash/thumbnail already captured on a prior scan.
          set: {
            phash: sql`coalesce(excluded.phash, ${images.phash})`,
            positionPct: sql`coalesce(excluded.position_pct, ${images.positionPct})`,
            thumbnailPath: sql`coalesce(excluded.thumbnail_path, ${images.thumbnailPath})`,
          },
        })
        .run();
    }
  });
}

// Images that have a thumbnail but no embedding yet, excluding boilerplate (never
// embedded — ADR 0014). Drives the post-scan embed pass and doubles as the re-embed
// query for a frozen-model migration (ADR 0016): null the column, re-run.
export async function getImagesNeedingEmbedding(
  limit = 10000,
): Promise<Array<{ id: number; thumbnailPath: string }>> {
  const rows = await db
    .select({ id: images.id, thumbnailPath: images.thumbnailPath })
    .from(images)
    .where(
      and(
        isNull(images.embedding),
        isNotNull(images.thumbnailPath),
        eq(images.isBoilerplate, false),
      ),
    )
    .limit(limit);
  return rows.filter(
    (r): r is { id: number; thumbnailPath: string } => r.thumbnailPath !== null,
  );
}

export async function updateImageEmbedding(
  id: number,
  embedding: Buffer,
  embedModel: string,
  embedDim: number,
): Promise<void> {
  await db.update(images).set({ embedding, embedModel, embedDim }).where(eq(images.id, id));
}

// Flag boilerplate: an identical phash appearing across >= minSales distinct sales
// is an org logo / filler banner, not a real item — excluded from training (ADR 0014).
// Recomputed wholesale each scan so the flag tracks the growing corpus in both
// directions. Near-dupe collapse happens within a sale (hamming threshold); this is
// exact-phash equality across sales.
export async function markBoilerplateImages(minSales = 5): Promise<void> {
  await db.run(sql`
    UPDATE images SET is_boilerplate = (
      phash IS NOT NULL AND phash IN (
        SELECT phash FROM images
        WHERE phash IS NOT NULL
        GROUP BY phash
        HAVING COUNT(DISTINCT sale_id) >= ${minSales}
      )
    )
  `);
}

// Generate finding_items for every finding that has none yet — for the pre-items
// backfill and for re-mining after the lexicon grows (drop the rows, re-run). Reuses
// each finding's own persisted provenance so backfilled items carry the right stamps.
export async function backfillFindingItems(): Promise<{ findings: number; items: number }> {
  const withItems = new Set(
    (await db.selectDistinct({ id: findingItems.findingId }).from(findingItems)).map((r) => r.id),
  );
  const all = await db
    .select({
      id: findings.id,
      saleId: findings.saleId,
      description: findings.description,
      confidence: findings.confidence,
      vlmModel: findings.vlmModel,
      promptVersion: findings.promptVersion,
    })
    .from(findings);

  let findingCount = 0;
  let itemCount = 0;
  for (const f of all) {
    if (withItems.has(f.id)) continue;
    const drafts = extractItems({
      description: f.description,
      confidence: f.confidence as Confidence | null,
    });
    if (drafts.length === 0) continue;
    await db
      .insert(findingItems)
      .values(itemRowsFor(f.id, f.saleId, drafts, f.vlmModel, f.promptVersion));
    findingCount++;
    itemCount += drafts.length;
  }
  return { findings: findingCount, items: itemCount };
}

export async function getScanRadiusMiles(): Promise<number> {
  const [settings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.ownerSub, DEV_USER_SUB));
  return settings?.radiusMiles ?? DEFAULT_RADIUS_MILES;
}
