import { db } from "../db/index.js";
import { findings, sales, userSettings } from "../db/schema.js";
import { DEFAULT_RADIUS_MILES } from "../lib/constants.js";
import type { ScrapedSale } from "../scraper/index.js";
import { DEV_USER_SUB } from "../types/env.js";
import { eq } from "drizzle-orm";

export async function getProcessedImageUrls(): Promise<Set<string>> {
  const rows = await db
    .select({ imageUrl: findings.imageUrl })
    .from(findings);

  return new Set(rows.map((row) => row.imageUrl));
}

export async function upsertSale(sale: ScrapedSale, scrapedAt: string) {
  await db.insert(sales).values({
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
  }).onConflictDoNothing();
}

export async function insertFinding(
  saleId: string,
  imageUrl: string,
  description: string,
  scrapedAt: string,
): Promise<void> {
  await db
    .insert(findings)
    .values({ saleId, imageUrl, description, scrapedAt })
    .onConflictDoNothing();
}

export async function insertFindingsBatch(
  saleId: string,
  batch: Array<{ imageUrl: string; description: string }>,
  scrapedAt: string,
): Promise<void> {
  if (batch.length === 0) return;
  await db.transaction(async (tx) => {
    for (const f of batch) {
      await tx
        .insert(findings)
        .values({ saleId, imageUrl: f.imageUrl, description: f.description, scrapedAt })
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
