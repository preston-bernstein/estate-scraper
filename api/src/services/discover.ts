import { and, gte, inArray, or, sql } from "drizzle-orm";
import { todayIsoDate } from "../lib/date.js";
import { escapeLike, expandQuery } from "../lib/thesaurus.js";
import { db } from "../db/index.js";
import { findingItems, findings, sales } from "../db/schema.js";
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

// Category-only matches (a Finding surfaced solely because its finding_items.category
// is implied by the query — e.g. "couch" -> seating — with no literal/synonym LIKE
// hit in its description) count toward a sale's score, but at less than a literal hit
// (10, below). This is a deliberate scoring decision (docs/semantic-search/plan.md
// "Design decisions"): category membership is a weaker relevance signal than an
// actual word match, so a sale that only matches via category never outranks one with
// a real text hit, preserving today's ordering for the common case.
const CATEGORY_ONLY_MATCH_WEIGHT = 3;

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

  // Phase 1 thesaurus expansion (docs/semantic-search): "couch" also matches
  // descriptions containing "sofa"/"chaise lounge"/"loveseat"/etc, and implies the
  // `seating` finding_items.category. Deterministic, no I/O, no LLM call (FR6/FR7).
  const { expandedTerms, categories } = expandQuery(terms);

  // Item-level match: findings whose description contains any expanded term (literal
  // query words plus curated synonyms). Each term is LIKE-escaped so a literal `%`
  // or `_` in a query can't turn into an unintended wildcard.
  const orClause = expandedTerms
    .map((t) => sql`lower(${findings.description}) like ${"%" + escapeLike(t) + "%"} escape '\\'`)
    .reduce((acc, cond) => or(acc, cond)!);

  const matched = await db
    .select()
    .from(findings)
    .where(and(inArray(findings.saleId, upcomingSaleIds), orClause));

  const matchedBySale = new Map<string, typeof matched>();
  const matchedIds = new Set<number>();
  for (const f of matched) {
    matchedIds.add(f.id);
    const list = matchedBySale.get(f.saleId) ?? [];
    list.push(f);
    matchedBySale.set(f.saleId, list);
  }

  // Category-sibling match (FR3/AC3): surfaces Findings whose finding_items.category
  // is one the query implies, even when the description text itself has no literal
  // or synonym hit — e.g. a Finding classified `seating` but worded in a way the
  // thesaurus didn't anticipate. Scoped to upcoming sales only, and de-duped against
  // findings already picked up by the literal LIKE match above.
  let categoryOnlyMatched: typeof matched = [];
  if (categories.length > 0) {
    const categoryItemRows = await db
      .select({ findingId: findingItems.findingId })
      .from(findingItems)
      .where(and(inArray(findingItems.saleId, upcomingSaleIds), inArray(findingItems.category, categories)));

    const categoryOnlyFindingIds = [...new Set(categoryItemRows.map((r) => r.findingId))].filter(
      (id) => !matchedIds.has(id),
    );

    if (categoryOnlyFindingIds.length > 0) {
      categoryOnlyMatched = await db
        .select()
        .from(findings)
        .where(inArray(findings.id, categoryOnlyFindingIds));
    }
  }

  const categoryOnlyBySale = new Map<string, typeof matched>();
  for (const f of categoryOnlyMatched) {
    const list = categoryOnlyBySale.get(f.saleId) ?? [];
    list.push(f);
    categoryOnlyBySale.set(f.saleId, list);
  }

  // Sale-level match: the search box promises "sales, items, cities", so a term hitting
  // the title / city / state / address counts even when no item description mentions it.
  // OR semantics (any term, any field) — the prior item-description-only match returned
  // nothing for city/title queries, which read as "search is broken".
  const saleTextMatch = new Set<string>();
  for (const s of upcomingSales) {
    const hay = `${s.title} ${s.city} ${s.state} ${s.address}`.toLowerCase();
    if (terms.some((t) => hay.includes(t))) saleTextMatch.add(s.saleId);
  }

  const resultSaleIds = [
    ...new Set([...matchedBySale.keys(), ...categoryOnlyBySale.keys(), ...saleTextMatch]),
  ];
  if (resultSaleIds.length === 0) return [];

  const allFindingsForSales = await db
    .select()
    .from(findings)
    .where(inArray(findings.saleId, resultSaleIds));

  const allFindingsBySale = new Map<string, typeof allFindingsForSales>();
  for (const f of allFindingsForSales) {
    const list = allFindingsBySale.get(f.saleId) ?? [];
    list.push(f);
    allFindingsBySale.set(f.saleId, list);
  }

  const results: RankedSale[] = [];

  for (const saleId of resultSaleIds) {
    const sale = saleById.get(saleId);
    if (!sale) continue;

    const saleMatched = matchedBySale.get(saleId) ?? [];
    const saleCategoryOnly = categoryOnlyBySale.get(saleId) ?? [];
    const saleAll = allFindingsBySale.get(saleId) ?? [];

    const topFindings = [...saleMatched, ...saleCategoryOnly]
      .map(toDiscoverFinding)
      .sort((a, b) => b.score - a.score);
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
      // Item matches rank above title/city-only matches; category-only matches count
      // too (FR3/AC3) but at CATEGORY_ONLY_MATCH_WEIGHT (< the literal-hit weight of
      // 10) so category-only sales never outrank a literal text match; distance
      // breaks ties.
      score:
        saleMatched.length * 10 +
        saleCategoryOnly.length * CATEGORY_ONLY_MATCH_WEIGHT +
        (saleTextMatch.has(saleId) ? 1 : 0),
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
