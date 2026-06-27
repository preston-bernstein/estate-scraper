import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { todayIsoDate } from "../lib/date.js";
import { db } from "../db/index.js";
import { findings, hunts, planItems, saleOutcomes, sales, userSettings } from "../db/schema.js";
import {
  aggregateHuntMatchCounts,
  findingMatchesKeywords,
  saleMatchesHunts,
} from "../lib/hunts.js";

export type FindingRow = typeof findings.$inferSelect;
export type SaleRow = typeof sales.$inferSelect;


export async function getUserHunts(ownerSub: string) {
  return db.select().from(hunts).where(eq(hunts.ownerSub, ownerSub));
}

export async function getFindingsForSale(saleId: string) {
  return db.select().from(findings).where(eq(findings.saleId, saleId));
}

async function getFindingsForSales(saleIds: string[]): Promise<Map<string, FindingRow[]>> {
  if (saleIds.length === 0) return new Map();
  const rows = await db.select().from(findings).where(inArray(findings.saleId, saleIds));
  const map = new Map<string, FindingRow[]>();
  for (const row of rows) {
    const list = map.get(row.saleId) ?? [];
    list.push(row);
    map.set(row.saleId, list);
  }
  return map;
}

function pickThumbnail(findingRows: FindingRow[]) {
  if (findingRows.length === 0) {
    return null;
  }

  const best = [...findingRows].sort(
    (a, b) => b.description.length - a.description.length,
  )[0];

  return {
    imageUrl: best.imageUrl,
    description: best.description,
  };
}

export async function buildSaleSummary(
  sale: SaleRow,
  userHunts: Awaited<ReturnType<typeof getUserHunts>>,
  findingRows: FindingRow[],
) {
  const matchedFindings = findingRows.filter((finding) =>
    userHunts.some((hunt) =>
      findingMatchesKeywords(finding.description, hunt.keywords),
    ),
  );

  const huntMatchCounts = aggregateHuntMatchCounts(
    matchedFindings.map((finding) => finding.description),
    userHunts,
  );

  const thumbnail = pickThumbnail(matchedFindings.length > 0 ? matchedFindings : findingRows);

  return {
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
    thumbnailUrl: thumbnail?.imageUrl ?? null,
    thumbnailDescription: thumbnail?.description ?? null,
    huntMatchCounts,
    totalMatchedFindings: matchedFindings.length,
  };
}

export async function listUpcomingSales(ownerSub: string) {
  const userHunts = await getUserHunts(ownerSub);
  if (userHunts.length === 0) {
    return { sales: [], noHunts: true as const };
  }

  const today = todayIsoDate();
  const upcomingSales = await db
    .select()
    .from(sales)
    .where(gte(sales.endDate, today))
    .orderBy(sales.startDate, sales.distanceMiles);

  const saleIds = upcomingSales.map((s) => s.saleId);
  const findingsMap = await getFindingsForSales(saleIds);
  const summaries = [];

  for (const sale of upcomingSales) {
    const saleFindings = findingsMap.get(sale.saleId) ?? [];
    if (!saleMatchesHunts(saleFindings.map((f) => f.description), userHunts)) {
      continue;
    }
    summaries.push(await buildSaleSummary(sale, userHunts, saleFindings));
  }

  return { sales: summaries, noHunts: false as const };
}

export async function listPastSales(ownerSub: string) {
  const userHunts = await getUserHunts(ownerSub);
  if (userHunts.length === 0) {
    return { sales: [], noHunts: true as const };
  }

  const today = todayIsoDate();
  const pastSales = await db
    .select()
    .from(sales)
    .where(lt(sales.endDate, today))
    .orderBy(desc(sales.endDate), sales.distanceMiles);

  const saleIds = pastSales.map((s) => s.saleId);
  const findingsMap = await getFindingsForSales(saleIds);
  const summaries = [];

  for (const sale of pastSales) {
    const saleFindings = findingsMap.get(sale.saleId) ?? [];
    if (!saleMatchesHunts(saleFindings.map((f) => f.description), userHunts)) {
      continue;
    }
    summaries.push(await buildSaleSummary(sale, userHunts, saleFindings));
  }

  return { sales: summaries, noHunts: false as const };
}

export async function getSaleDetail(ownerSub: string, saleId: string) {
  const [sale] = await db.select().from(sales).where(eq(sales.saleId, saleId));
  if (!sale) {
    return null;
  }

  const userHunts = await getUserHunts(ownerSub);
  const saleFindings = await getFindingsForSale(saleId);

  const matchedFindings = saleFindings.filter((finding) =>
    userHunts.some((hunt) =>
      findingMatchesKeywords(finding.description, hunt.keywords),
    ),
  );

  return {
    sale: await buildSaleSummary(sale, userHunts, saleFindings),
    findings: saleFindings.map((finding) => ({
      id: finding.id,
      saleId: finding.saleId,
      imageUrl: finding.imageUrl,
      description: finding.description,
      scrapedAt: finding.scrapedAt,
      matched: userHunts.some((hunt) =>
        findingMatchesKeywords(finding.description, hunt.keywords),
      ),
    })),
    matchedFindingCount: matchedFindings.length,
    totalFindingCount: saleFindings.length,
  };
}

export type FindingWithSale = {
  id: number;
  saleId: string;
  imageUrl: string;
  description: string;
  scrapedAt: string;
  saleTitle: string;
  saleStartDate: string;
  saleEndDate: string;
  distanceMiles: number;
};

export async function searchFindings(keywords: string[]): Promise<FindingWithSale[]> {
  if (keywords.length === 0) return [];

  const conditions = keywords.map(
    (k) => sql`lower(${findings.description}) like ${"%" + k.toLowerCase() + "%"}`,
  );
  const whereClause = conditions.reduce((acc, cond) => or(acc, cond)!);

  const rows = await db
    .select({
      id: findings.id,
      saleId: findings.saleId,
      imageUrl: findings.imageUrl,
      description: findings.description,
      scrapedAt: findings.scrapedAt,
      saleTitle: sales.title,
      saleStartDate: sales.startDate,
      saleEndDate: sales.endDate,
      distanceMiles: sales.distanceMiles,
    })
    .from(findings)
    .innerJoin(sales, eq(findings.saleId, sales.saleId))
    .where(whereClause)
    .orderBy(desc(sales.startDate));

  return rows;
}

export async function getLastScannedAt(): Promise<string | null> {
  const [row] = await db
    .select({ lastScannedAt: sql<string | null>`max(${sales.scrapedAt})` })
    .from(sales);

  return row?.lastScannedAt ?? null;
}

export async function getUserSettings(ownerSub: string) {
  const [settings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.ownerSub, ownerSub));

  return {
    radiusMiles: settings?.radiusMiles ?? 30,
  };
}

export async function upsertUserSettings(
  ownerSub: string,
  radiusMiles: number,
) {
  await db
    .insert(userSettings)
    .values({ ownerSub, radiusMiles })
    .onConflictDoUpdate({
      target: userSettings.ownerSub,
      set: { radiusMiles },
    });

  return { radiusMiles };
}

export async function listPlanItems(ownerSub: string) {
  const items = await db
    .select()
    .from(planItems)
    .where(eq(planItems.ownerSub, ownerSub))
    .orderBy(planItems.sortOrder);

  if (items.length === 0) return [];

  const userHunts = await getUserHunts(ownerSub);
  const saleIds = items.map((item) => item.saleId);

  const saleRows = await db.select().from(sales).where(inArray(sales.saleId, saleIds));
  const saleMap = new Map(saleRows.map((s) => [s.saleId, s]));
  const findingsMap = await getFindingsForSales(saleIds);

  const plannedSales = [];
  for (const item of items) {
    const sale = saleMap.get(item.saleId);
    if (!sale) continue;
    const saleFindings = findingsMap.get(item.saleId) ?? [];
    plannedSales.push({
      sortOrder: item.sortOrder,
      ...(await buildSaleSummary(sale, userHunts, saleFindings)),
    });
  }

  return plannedSales;
}

export async function addPlanItem(ownerSub: string, saleId: string) {
  const [sale] = await db.select().from(sales).where(eq(sales.saleId, saleId));
  if (!sale) {
    return null;
  }

  const existing = await db
    .select()
    .from(planItems)
    .where(and(eq(planItems.ownerSub, ownerSub), eq(planItems.saleId, saleId)));

  if (existing.length > 0) {
    return existing[0];
  }

  const [maxOrder] = await db
    .select({ maxOrder: sql<number | null>`max(${planItems.sortOrder})` })
    .from(planItems)
    .where(eq(planItems.ownerSub, ownerSub));

  const sortOrder = (maxOrder?.maxOrder ?? -1) + 1;

  const [created] = await db
    .insert(planItems)
    .values({ ownerSub, saleId, sortOrder })
    .returning();

  return created;
}

export async function removePlanItem(ownerSub: string, saleId: string) {
  await db
    .delete(planItems)
    .where(and(eq(planItems.ownerSub, ownerSub), eq(planItems.saleId, saleId)));
}

export async function reorderPlanItems(ownerSub: string, saleIds: string[]) {
  db.transaction((tx) => {
    for (const [index, saleId] of saleIds.entries()) {
      tx.update(planItems)
        .set({ sortOrder: index })
        .where(and(eq(planItems.ownerSub, ownerSub), eq(planItems.saleId, saleId)))
        .run();
    }
  });
}

export async function getPlanSaleIds(ownerSub: string) {
  const items = await db
    .select({ saleId: planItems.saleId })
    .from(planItems)
    .where(eq(planItems.ownerSub, ownerSub))
    .orderBy(planItems.sortOrder);

  return items.map((item) => item.saleId);
}

export async function getOutcome(saleId: string, ownerSub: string) {
  const [row] = await db
    .select()
    .from(saleOutcomes)
    .where(and(eq(saleOutcomes.saleId, saleId), eq(saleOutcomes.ownerSub, ownerSub)));
  return row ?? null;
}

export async function recordOutcome(
  saleId: string,
  ownerSub: string,
  attended: boolean,
  outcome: "good" | "meh" | "waste",
  notes: string | null,
): Promise<void> {
  await db
    .insert(saleOutcomes)
    .values({
      saleId,
      ownerSub,
      attended,
      outcome,
      notes,
      recordedAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
}
