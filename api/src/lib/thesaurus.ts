// Phase 1 semantic-search thesaurus (docs/semantic-search): a static, checked-in
// synonym + category map that lets a Discover search for an everyday word ("couch")
// surface Findings described with a different but synonymous word ("sofa", "chaise
// lounge") or classified into the same finding_items.category ("seating"), without
// any LLM call or network I/O (FR1/FR5/FR6/FR7). Reuses the closed 15-value Category
// vocab from items.ts (ADR 0018) rather than inventing a parallel type.
import type { Category } from "./items.js";

// ── Category → everyday terms ────────────────────────────────────────────────────
// What a casual, non-technical shopper types when they mean "this category." Doubles
// as the canonical/aliases group for the synonym map below (see SYNONYMS): every term
// in a category's list is treated as interchangeable with every other term in that
// same list for expansion purposes, which is the cheapest way to keep the two maps
// from drifting out of sync with each other. `seating` and `electronics` are fully
// populated per the Phase 1 requirement (electronics because "record player" is a
// named target query); the remaining 13 categories carry a reasonable starter set,
// extendable later without touching expandQuery's logic (FR5).
const CATEGORY_TERMS: Record<Category, string[]> = {
  seating: [
    "couch", "sofa", "settee", "loveseat", "sectional", "chaise", "chaise lounge",
    "divan", "davenport", "futon", "recliner", "ottoman", "bench",
  ],
  electronics: [
    "record player", "turntable", "hi-fi", "hifi", "stereo", "receiver", "amplifier",
    "amp", "speakers", "speaker", "console tv", "tube tv", "tube radio", "radio",
    "reel-to-reel", "reel to reel", "camera", "game console", "video game console",
    "television", "tv",
  ],
  tables: ["table", "desk", "coffee table", "dining table", "nightstand", "end table", "console table"],
  case_goods: ["dresser", "credenza", "cabinet", "armoire", "bureau", "sideboard", "buffet", "chest", "hutch", "bookcase", "wardrobe"],
  beds: ["bed", "headboard", "footboard", "four-poster bed", "canopy bed", "bed frame"],
  lighting: ["lamp", "chandelier", "sconce", "lantern", "light fixture", "floor lamp", "table lamp"],
  clocks: ["clock", "grandfather clock", "mantel clock", "wall clock", "cuckoo clock"],
  art: ["painting", "print", "artwork", "sculpture", "statue", "drawing", "framed art", "mirror"],
  ceramics_glass: ["pottery", "porcelain", "china", "crystal", "glassware", "vase", "figurine", "dishes"],
  silver: ["silverware", "flatware", "sterling", "silver plate", "candlesticks"],
  jewelry_watches: ["jewelry", "necklace", "ring", "bracelet", "brooch", "watch", "wristwatch", "pocket watch"],
  games_toys: ["toy", "toys", "board game", "doll", "action figure", "puzzle", "lego"],
  instruments: ["guitar", "piano", "violin", "banjo", "drum", "drums", "trumpet", "saxophone"],
  kitsch: ["kitsch", "novelty", "lava lamp", "snow globe", "tiki", "velvet painting", "taxidermy"],
  other: [],
};

// ── Synonym map (canonical → everyday terms), LEXICON-pattern ────────────────────
// One representative canonical name per category, whose "aliases" are the category's
// whole everyday-term list above (kept as the SAME array reference — not copied — so
// the two maps can't silently drift apart). A user typing ANY term in the group
// expands to every OTHER term in that group, which is what makes "couch" pull in
// "chaise lounge"/"loveseat"/"sectional" (AC1/AC2) without a bespoke rule per word.
const SYNONYMS: Record<string, string[]> = {
  sofa: CATEGORY_TERMS.seating,
  "record player": CATEGORY_TERMS.electronics,
  table: CATEGORY_TERMS.tables,
  dresser: CATEGORY_TERMS.case_goods,
  bed: CATEGORY_TERMS.beds,
  lamp: CATEGORY_TERMS.lighting,
  clock: CATEGORY_TERMS.clocks,
  painting: CATEGORY_TERMS.art,
  vase: CATEGORY_TERMS.ceramics_glass,
  silverware: CATEGORY_TERMS.silver,
  jewelry: CATEGORY_TERMS.jewelry_watches,
  toy: CATEGORY_TERMS.games_toys,
  guitar: CATEGORY_TERMS.instruments,
  kitsch: CATEGORY_TERMS.kitsch,
  // "other" intentionally omitted — it's the catch-all bucket, not an everyday term.
};

// Lower-cased alias → canonical, longest-alias-first (mirrors lexicon.ts's
// ALIAS_INDEX) so a longer, more specific phrase wins over a short one it contains.
const ALIAS_INDEX: Array<{ alias: string; canonical: string }> = Object.entries(SYNONYMS)
  .flatMap(([canonical, aliases]) => aliases.map((alias) => ({ alias: alias.toLowerCase(), canonical })))
  .sort((a, b) => b.alias.length - a.alias.length);

// category → its term set, lower-cased, for O(1) "does this phrase name this
// category" membership checks in expandQuery.
const CATEGORY_TERM_SETS: Array<{ category: Category; terms: Set<string> }> = (
  Object.entries(CATEGORY_TERMS) as Array<[Category, string[]]>
).map(([category, terms]) => ({
  category,
  terms: new Set(terms.map((t) => t.toLowerCase())),
}));

/**
 * Escapes SQLite LIKE metacharacters (`%`, `_`, and the escape character `\` itself)
 * in a term destined for a `LIKE '%term%' ESCAPE '\'` clause, so a literal `%` or `_`
 * in a search query can't turn into an unintended wildcard. Escape the backslash
 * FIRST — escaping it after `%`/`_` would double-escape the backslashes just inserted.
 */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export type ExpandedQuery = {
  literalTerms: string[];
  expandedTerms: string[];
  categories: Category[];
};

/**
 * Expands a caller's already-tokenized search terms into a superset of literal terms
 * plus curated synonyms, and the set of finding_items.category values (ADR 0018)
 * those terms imply — deterministic, pure, no I/O (FR6/FR7). `expandedTerms` always
 * contains every entry of `literalTerms` (FR2/AC10: literal matching is preserved).
 *
 * Multi-word canonical entries ("record player", "chaise lounge") are matched by also
 * checking adjacent-term bigrams, so a multi-word query like "record player" expands
 * correctly even though callers pass already-split single-word terms (AC14).
 */
export function expandQuery(terms: string[]): ExpandedQuery {
  const literalTerms = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (literalTerms.length === 0) return { literalTerms: [], expandedTerms: [], categories: [] };

  const candidates = new Set<string>(literalTerms);
  for (let i = 0; i < literalTerms.length - 1; i++) {
    candidates.add(`${literalTerms[i]} ${literalTerms[i + 1]}`);
  }

  const expandedTerms = new Set<string>(literalTerms);
  const categories = new Set<Category>();

  for (const candidate of candidates) {
    const alias = ALIAS_INDEX.find((a) => a.alias === candidate);
    if (alias) {
      expandedTerms.add(alias.canonical.toLowerCase());
      for (const syn of SYNONYMS[alias.canonical] ?? []) expandedTerms.add(syn.toLowerCase());
    }
    for (const { category, terms: termSet } of CATEGORY_TERM_SETS) {
      if (termSet.has(candidate)) categories.add(category);
    }
  }

  return {
    literalTerms,
    expandedTerms: [...expandedTerms],
    categories: [...categories],
  };
}
