import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { findings, images, sales, userSettings } from "../db/schema.js";
import { DEFAULT_RADIUS_MILES } from "../lib/scraping.js";
import type { AnalysisPhase, Confidence } from "../vision/index.js";
import type { ScrapedSale } from "../scraper/index.js";
import { DEV_USER_SUB } from "../types/env.js";

export async function getProcessedImageUrls(): Promise<Set<string>> {
  const rows = await db.select({ imageUrl: findings.imageUrl }).from(findings);
  return new Set(rows.map((row) => row.imageUrl));
}

// Insert-or-get the durable Image row for an analyzed photo (ADR 0014).
// UNIQUE(sale_id, image_url) gives scan idempotency: a re-scanned sale links to the
// existing row instead of duplicating it. embedding/phash/thumbnail are filled by the
// vision pipeline (TODO) — null here keeps existing behavior non-breaking.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function upsertImage(
  tx: Tx,
  saleId: string,
  imageUrl: string,
  positionPct: number | null,
): Promise<number> {
  await tx
    .insert(images)
    .values({ saleId, imageUrl, positionPct })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.saleId, saleId), eq(images.imageUrl, imageUrl)));
  return row.id;
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
  await db.transaction(async (tx) => {
    const imageId = await upsertImage(tx, saleId, imageUrl, null);
    await tx
      .insert(findings)
      .values({ saleId, imageId, imageUrl, description, scrapedAt })
      .onConflictDoNothing();
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
  await db.transaction(async (tx) => {
    for (const f of batch) {
      const imageId = await upsertImage(tx, saleId, f.imageUrl, f.imagePositionPct);
      await tx
        .insert(findings)
        .values({
          saleId,
          imageId,
          imageUrl: f.imageUrl,
          description: f.description,
          scrapedAt,
          confidence: f.confidence,
          imagePositionPct: f.imagePositionPct,
        })
        .onConflictDoNothing();
    }
  });
}

export async function getScanRadiusMiles(): Promise<number> {
  const [settings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.ownerSub, DEV_USER_SUB));
  return settings?.radiusMiles ?? DEFAULT_RADIUS_MILES;
}
