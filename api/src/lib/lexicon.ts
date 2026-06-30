// The maker lexicon — the SOLE authority for the normalized `finding_items.maker`
// field (ADR 0014). A canonical name maps to the raw aliases/spellings a VLM might
// emit; resolveMakers() only ever returns a canonical, so the column stays clean and
// joinable. `maker_raw` keeps the matched raw text so a row can be re-mined when the
// lexicon grows. Designed to grow: add aliases freely, re-run the backfill to
// re-resolve historic findings.
//
// Seeded from the makers named in the vision prompt (lib/vision.ts) plus the makers
// that recur in estate sales. Not exhaustive — NULL maker is expected and fine.

export const LEXICON: Record<string, string[]> = {
  // ── Furniture ──────────────────────────────────────────────────────────────
  Stickley: ["stickley"],
  Henredon: ["henredon"],
  Baker: ["baker furniture"],
  Drexel: ["drexel", "drexel heritage"],
  Broyhill: ["broyhill", "broyhill brasilia"],
  Lane: ["lane furniture", "lane altavista"],
  "Ethan Allen": ["ethan allen"],
  Thomasville: ["thomasville"],
  "Heywood-Wakefield": ["heywood-wakefield", "heywood wakefield"],
  "Herman Miller": ["herman miller"],
  Knoll: ["knoll"],
  Eames: ["eames"],
  Bassett: ["bassett"],
  // ── Ceramics / glass / pottery ──────────────────────────────────────────────
  Roseville: ["roseville"],
  Hull: ["hull pottery"],
  McCoy: ["mccoy"],
  Fenton: ["fenton"],
  Waterford: ["waterford"],
  Lenox: ["lenox"],
  Wedgwood: ["wedgwood", "wedgewood"],
  Tiffany: ["tiffany", "tiffany-style", "tiffany style"],
  Limoges: ["limoges"],
  // ── Silver ──────────────────────────────────────────────────────────────────
  Gorham: ["gorham"],
  "Reed & Barton": ["reed & barton", "reed and barton"],
  Towle: ["towle"],
  Wallace: ["wallace silver"],
  // ── Clocks ──────────────────────────────────────────────────────────────────
  "Howard Miller": ["howard miller"],
  "Seth Thomas": ["seth thomas"],
  // ── Hi-fi / electronics / cameras ───────────────────────────────────────────
  Pioneer: ["pioneer"],
  Marantz: ["marantz"],
  McIntosh: ["mcintosh"],
  Zenith: ["zenith"],
  "Bang & Olufsen": ["bang & olufsen", "bang and olufsen", "b&o"],
  Bose: ["bose"],
  Polaroid: ["polaroid"],
  Nikon: ["nikon"],
  Canon: ["canon"],
  Leica: ["leica"],
  Kodak: ["kodak"],
  // ── Computers / consoles / games ────────────────────────────────────────────
  Atari: ["atari", "atari 2600", "atari 800"],
  Nintendo: ["nintendo", "nes", "super nintendo", "snes"],
  Sega: ["sega", "sega genesis", "genesis console"],
  ColecoVision: ["colecovision", "coleco"],
  Intellivision: ["intellivision"],
  Commodore: ["commodore", "commodore 64", "c64", "amiga"],
  Apple: ["apple ii", "apple //e", "macintosh", "mac plus"],
  Tandy: ["trs-80", "tandy"],
};

// Lower-cased alias → canonical, longest-alias-first so "atari 2600" wins over "atari".
const ALIAS_INDEX: Array<{ alias: string; canonical: string }> = Object.entries(LEXICON)
  .flatMap(([canonical, aliases]) => aliases.map((alias) => ({ alias: alias.toLowerCase(), canonical })))
  .sort((a, b) => b.alias.length - a.alias.length);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A match must be bounded by non-alphanumerics (or string ends) so "lane" doesn't
// fire inside "planer" and "baker" doesn't fire inside "bakery". Handles aliases
// with punctuation (& , -) that \b can't bracket reliably.
function aliasMatches(text: string, alias: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`, "i");
  return re.test(text);
}

export type MakerMatch = { maker: string; raw: string };

// All canonical makers whose aliases appear in the text, each with the raw alias
// that matched (for maker_raw). De-duped by canonical, first (longest) match wins.
export function resolveMakers(text: string): MakerMatch[] {
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  const out: MakerMatch[] = [];
  for (const { alias, canonical } of ALIAS_INDEX) {
    if (seen.has(canonical)) continue;
    if (aliasMatches(lower, alias)) {
      seen.add(canonical);
      out.push({ maker: canonical, raw: alias });
    }
  }
  return out;
}
