import { and, gte, inArray, or, sql } from "drizzle-orm";
import { todayIsoDate } from "../lib/date.js";
import { db } from "../db/index.js";
import { findings, sales } from "../db/schema.js";
import { thumbUrlForImageId } from "./sales.js";

const ELECTRONICS = /atari|sega|nintendo|commodore|colecovision|intellivision|arcade|console|cartridge|reel.to.reel|turntable|amplifier|receiver|tube radio|tube tv|polaroid|apple ii|trs-80|commodore 64/i;
const KITSCH = /velvet|paint.by.number|taxidermy|ceramic.*rooster|ceramic.*poodle|ceramic.*flamingo|tiki|lava lamp|snow globe|outsider|kitschy|novelty figurine|rooster.*lamp|rooster.*figurine/i;
const BRAND = /stickley|henredon|baker |drexel|broyhill|tiffany|thomasville|ethan allen|atari|sega|nintendo|commodore|polaroid|pioneer|zenith|marantz|carrara marble/i;
const ERA = /mid.century|victorian|arts.?&?.?crafts|art.deco|art.nouveau|mission|craftsman|shaker|antique|circa|18th century|19th century|early 20th/i;

export type DiscoverFinding = {
  id: number;
  imageUrl: string;
  thumbUrl: string | null;
  description: string;
  score: number;
  tag: "electronics" | "kitsch" | "collectible" | "furniture";
};

export type RankedSale = {
  saleId: string;
  title: string;
  url: string;
  startDate: string;
  endDate: string;
  distanceMiles: number;
  address: string;
  city: string;
  state: string;
  score: number;
  totalFindings: number;
  topFindings: DiscoverFinding[];
  tally: { electronics: number; kitsch: number; collectibles: number; furniture: number };
};

export type Standout = {
  id: number;
  imageUrl: string;
  thumbUrl: string | null;
  description: string;
  saleId: string;
  saleTitle: string;
  distanceMiles: number;
  score: number;
  tag: DiscoverFinding["tag"];
};

type FindingLike = {
  id: number;
  imageId: number | null;
  imageUrl: string;
  description: string;
  confidence: string | null;
};

function toDiscoverFinding(f: FindingLike): DiscoverFinding {
  return {
    id: f.id,
    imageUrl: f.imageUrl,
    thumbUrl: thumbUrlForImageId(f.imageId),
    description: f.description,
    score: scoreFinding(f.description, f.confidence),
    tag: tagFinding(f.description),
  };
}

function tallyFindings(descriptions: string[]): RankedSale["tally"] {
  const tally = { electronics: 0, kitsch: 0, collectibles: 0, furniture: 0 };
  for (const desc of descriptions) {
    const tag = tagFinding(desc);
    if (tag === "electronics") tally.electronics++;
    else if (tag === "kitsch") tally.kitsch++;
    else if (tag === "collectible") tally.collectibles++;
    else tally.furniture++;
  }
  return tally;
}

function tagFinding(desc: string): DiscoverFinding["tag"] {
  if (ELECTRONICS.test(desc)) return "electronics";
  if (KITSCH.test(desc)) return "kitsch";
  if (/clock|grandfather|lamp|artwork|jewelry|silver|china|pottery/i.test(desc)) return "collectible";
  return "furniture";
}

const CONFIDENCE_MULTIPLIER: Record<string, number> = {
  high: 1.3,
  medium: 1.0,
  low: 0.6,
};

function scoreFinding(desc: string, confidence: string | null): number {
  let score = 1;
  if (BRAND.test(desc)) score += 4;
  if (ERA.test(desc)) score += 2;
  if (ELECTRONICS.test(desc)) score += 3;
  if (KITSCH.test(desc)) score += 3;
  if (desc.length > 50) score += 1;
  return score * (CONFIDENCE_MULTIPLIER[confidence ?? ""] ?? 1.0);
}


export async function getDiscoverData(): Promise<{
  rankedSales: RankedSale[];
  standouts: Standout[];
}> {
  const today = todayIsoDate();

  const upcomingSales = await db
    .select()
    .from(sales)
    .where(gte(sales.endDate, today))
    .orderBy(sales.distanceMiles);

  if (upcomingSales.length === 0) return { rankedSales: [], standouts: [] };

  const saleIds = upcomingSales.map((s) => s.saleId);
  const allFindings = await db
    .select()
    .from(findings)
    .where(inArray(findings.saleId, saleIds));

  const findingsBySale = new Map<string, typeof allFindings>();
  for (const f of allFindings) {
    const list = findingsBySale.get(f.saleId) ?? [];
    list.push(f);
    findingsBySale.set(f.saleId, list);
  }

  const rankedSales: RankedSale[] = [];

  for (const sale of upcomingSales) {
    const saleFindings = findingsBySale.get(sale.saleId) ?? [];
    if (saleFindings.length === 0) continue;

    const scored = saleFindings.map(toDiscoverFinding);
    const tally = tallyFindings(saleFindings.map((f) => f.description));
    const saleScore = scored.reduce((sum, f) => sum + f.score, 0);
    const topFindings = [...scored].sort((a, b) => b.score - a.score).slice(0, 6);

    rankedSales.push({
      saleId: sale.saleId,
      title: sale.title,
      url: sale.url,
      startDate: sale.startDate,
      endDate: sale.endDate,
      distanceMiles: sale.distanceMiles,
      address: sale.address,
      city: sale.city,
      state: sale.state,
      score: saleScore,
      totalFindings: saleFindings.length,
      topFindings,
      tally,
    });
  }

  rankedSales.sort((a, b) => b.score - a.score);

  // Standouts: top-scored individual finds across all sales
  const standouts: Standout[] = [];
  for (const sale of upcomingSales) {
    const saleFindings = findingsBySale.get(sale.saleId) ?? [];
    for (const f of saleFindings) {
      const score = scoreFinding(f.description, f.confidence);
      if (score >= 4) {
        standouts.push({
          ...toDiscoverFinding(f),
          saleId: sale.saleId,
          saleTitle: sale.title,
          distanceMiles: sale.distanceMiles,
          score,
        });
      }
    }
  }

  standouts.sort((a, b) => b.score - a.score);

  return { rankedSales, standouts: standouts.slice(0, 30) };
}

export async function searchSales(query: string): Promise<RankedSale[]> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const today = todayIsoDate();

  const upcomingSales = await db
    .select()
    .from(sales)
    .where(gte(sales.endDate, today));

  if (upcomingSales.length === 0) return [];

  const upcomingSaleIds = upcomingSales.map((s) => s.saleId);
  const saleById = new Map(upcomingSales.map((s) => [s.saleId, s]));

  const termConditions = terms.map(
    (t) => sql`lower(${findings.description}) like ${"%" + t + "%"}`,
  );
  const orClause = termConditions.reduce((acc, cond) => or(acc, cond)!);

  const matched = await db
    .select()
    .from(findings)
    .where(and(inArray(findings.saleId, upcomingSaleIds), orClause));

  if (matched.length === 0) return [];

  const matchedBySale = new Map<string, typeof matched>();
  for (const f of matched) {
    const list = matchedBySale.get(f.saleId) ?? [];
    list.push(f);
    matchedBySale.set(f.saleId, list);
  }

  const matchedSaleIds = [...matchedBySale.keys()];

  const allFindingsForSales = await db
    .select()
    .from(findings)
    .where(inArray(findings.saleId, matchedSaleIds));

  const allFindingsBySale = new Map<string, typeof allFindingsForSales>();
  for (const f of allFindingsForSales) {
    const list = allFindingsBySale.get(f.saleId) ?? [];
    list.push(f);
    allFindingsBySale.set(f.saleId, list);
  }

  const results: RankedSale[] = [];

  for (const saleId of matchedSaleIds) {
    const sale = saleById.get(saleId);
    if (!sale) continue;

    const saleMatched = matchedBySale.get(saleId) ?? [];
    const saleAll = allFindingsBySale.get(saleId) ?? [];

    const topFindings = saleMatched.map(toDiscoverFinding).sort((a, b) => b.score - a.score);
    const tally = tallyFindings(saleAll.map((f) => f.description));

    results.push({
      saleId: sale.saleId,
      title: sale.title,
      url: sale.url,
      startDate: sale.startDate,
      endDate: sale.endDate,
      distanceMiles: sale.distanceMiles,
      address: sale.address,
      city: sale.city,
      state: sale.state,
      score: saleMatched.length,
      totalFindings: saleAll.length,
      topFindings,
      tally,
    });
  }

  results.sort((a, b) => b.score - a.score || a.distanceMiles - b.distanceMiles);
  return results;
}

export async function getRecentFindingsContext(): Promise<string> {
  const today = todayIsoDate();
  const upcomingSales = await db
    .select()
    .from(sales)
    .where(gte(sales.endDate, today))
    .orderBy(sales.distanceMiles);

  if (upcomingSales.length === 0) return "No upcoming estate sales found.";

  const saleIds = upcomingSales.map((s) => s.saleId);
  const allFindings = await db
    .select()
    .from(findings)
    .where(inArray(findings.saleId, saleIds));

  const findingsBySale = new Map<string, typeof allFindings>();
  for (const f of allFindings) {
    const list = findingsBySale.get(f.saleId) ?? [];
    list.push(f);
    findingsBySale.set(f.saleId, list);
  }

  const lines: string[] = [];
  for (const sale of upcomingSales) {
    const saleFindings = findingsBySale.get(sale.saleId) ?? [];
    if (saleFindings.length === 0) continue;
    const top = [...saleFindings]
      .sort((a, b) => scoreFinding(b.description, b.confidence) - scoreFinding(a.description, a.confidence))
      .slice(0, 15);
    lines.push(`\nSale: "${sale.title}" (${sale.saleId}) — ${sale.distanceMiles.toFixed(1)}mi, ${sale.city} ${sale.state}`);
    lines.push(`Dates: ${sale.startDate} to ${sale.endDate}`);
    lines.push(`Findings (${saleFindings.length} total, showing top):`);
    for (const f of top) lines.push(`  - ${f.description}`);
  }

  return lines.join("\n");
}
