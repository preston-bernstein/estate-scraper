import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { findings, sales } from "../db/schema.js";
import type { ScrapedSale } from "../scraper/index.js";

export async function getProcessedImageUrls(): Promise<Set<string>> {
  const rows = await db
    .select({ imageUrl: findings.imageUrl })
    .from(findings);

  return new Set(rows.map((row) => row.imageUrl));
}

export async function upsertSale(sale: ScrapedSale, scrapedAt: string) {
  const existing = await db
    .select({ saleId: sales.saleId })
    .from(sales)
    .where(eq(sales.saleId, sale.saleId));

  if (existing.length > 0) {
    return;
  }

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
  });
}

export async function insertFinding(
  saleId: string,
  imageUrl: string,
  description: string,
  scrapedAt: string,
) {
  const existing = await db
    .select({ id: findings.id })
    .from(findings)
    .where(eq(findings.imageUrl, imageUrl));

  if (existing.length > 0) {
    return;
  }

  await db.insert(findings).values({
    saleId,
    imageUrl,
    description,
    scrapedAt,
  });
}

export async function getScanRadiusMiles(): Promise<number> {
  const { userSettings } = await import("../db/schema.js");
  const [settings] = await db.select().from(userSettings).limit(1);
  return settings?.radiusMiles ?? 30;
}
