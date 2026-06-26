import { gte, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { findings, sales } from "../db/schema.js";

const ELECTRONICS = /atari|sega|nintendo|commodore|colecovision|intellivision|arcade|console|cartridge|reel.to.reel|turntable|amplifier|receiver|tube radio|tube tv|polaroid|apple ii|trs-80|commodore 64/i;
const KITSCH = /velvet|paint.by.number|taxidermy|ceramic.*rooster|ceramic.*poodle|ceramic.*flamingo|tiki|lava lamp|snow globe|outsider|kitschy|novelty figurine|rooster.*lamp|rooster.*figurine/i;
const BRAND = /stickley|henredon|baker |drexel|broyhill|tiffany|thomasville|ethan allen|atari|sega|nintendo|commodore|polaroid|pioneer|zenith|marantz|carrara marble/i;
const ERA = /mid.century|victorian|arts.?&?.?crafts|art.deco|art.nouveau|mission|craftsman|shaker|antique|circa|18th century|19th century|early 20th/i;

export type DiscoverFinding = {
  id: number;
  imageUrl: string;
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
  description: string;
  saleId: string;
  saleTitle: string;
  distanceMiles: number;
  score: number;
  tag: DiscoverFinding["tag"];
};

function tagFinding(desc: string): DiscoverFinding["tag"] {
  if (ELECTRONICS.test(desc)) return "electronics";
  if (KITSCH.test(desc)) return "kitsch";
  if (/clock|grandfather|lamp|artwork|jewelry|silver|china|pottery/i.test(desc)) return "collectible";
  return "furniture";
}

function scoreFinding(desc: string): number {
  let score = 1;
  if (BRAND.test(desc)) score += 4;
  if (ERA.test(desc)) score += 2;
  if (ELECTRONICS.test(desc)) score += 3;
  if (KITSCH.test(desc)) score += 3;
  if (desc.length > 50) score += 1;
  return score;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
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

    const scored = saleFindings.map((f) => ({
      id: f.id,
      imageUrl: f.imageUrl,
      description: f.description,
      score: scoreFinding(f.description),
      tag: tagFinding(f.description),
    }));

    const tally = { electronics: 0, kitsch: 0, collectibles: 0, furniture: 0 };
    for (const f of scored) {
      if (f.tag === "electronics") tally.electronics++;
      else if (f.tag === "kitsch") tally.kitsch++;
      else if (f.tag === "collectible") tally.collectibles++;
      else tally.furniture++;
    }

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
      const score = scoreFinding(f.description);
      if (score >= 4) {
        standouts.push({
          id: f.id,
          imageUrl: f.imageUrl,
          description: f.description,
          saleId: sale.saleId,
          saleTitle: sale.title,
          distanceMiles: sale.distanceMiles,
          score,
          tag: tagFinding(f.description),
        });
      }
    }
  }

  standouts.sort((a, b) => b.score - a.score);

  return { rankedSales, standouts: standouts.slice(0, 30) };
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
      .sort((a, b) => scoreFinding(b.description) - scoreFinding(a.description))
      .slice(0, 15);
    lines.push(`\nSale: "${sale.title}" (${sale.saleId}) — ${sale.distanceMiles.toFixed(1)}mi, ${sale.city} ${sale.state}`);
    lines.push(`Dates: ${sale.startDate} to ${sale.endDate}`);
    lines.push(`Findings (${saleFindings.length} total, showing top):`);
    for (const f of top) lines.push(`  - ${f.description}`);
  }

  return lines.join("\n");
}
