import type { Confidence } from "../vision/index.js";
import { resolveMakers } from "./lexicon.js";

// Closed category vocabulary (ADR 0014, 0018). Keep this list small and stable —
// it is a queryable facet, not a free-text field. Anything that doesn't match falls
// to "other" rather than spawning a new category. Mirrors the taste areas in the
// vision prompt (furniture/antiques, kitsch/camp, vintage electronics & games).
export const CATEGORIES = [
  "seating",
  "tables",
  "case_goods",
  "beds",
  "lighting",
  "clocks",
  "art",
  "ceramics_glass",
  "silver",
  "jewelry_watches",
  "electronics",
  "games_toys",
  "instruments",
  "kitsch",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type ItemConfidence = "high" | "med" | "low";

export type ItemDraft = {
  maker: string | null;
  makerRaw: string | null;
  category: Category;
  era: string | null;
  desirability: ItemConfidence;
  matchedLexicon: string[];
  itemDesc: string;
  source: "vlm" | "lexicon";
  idConfidence: ItemConfidence;
};

// Ordered most-specific-first: the first category with a keyword hit wins, so kitsch
// and named electronics beat the broad furniture buckets. Word-ish matching via
// includes() on a space-padded lower-cased line is enough for the VLM's short lines.
const CATEGORY_RULES: Array<{ category: Category; keywords: string[] }> = [
  {
    category: "kitsch",
    keywords: [
      "velvet painting", "velvet elvis", "paint-by-number", "paint by number",
      "taxidermy", "tiki", "lava lamp", "snow globe", "ceramic rooster",
      "ceramic poodle", "flamingo", "novelty", "kitsch", "camp", "religious figure",
      "carnival", "black velvet",
    ],
  },
  {
    category: "games_toys",
    keywords: [
      "console", "video game", "cartridge", "atari", "nintendo", "nes", "snes",
      "sega", "genesis", "colecovision", "intellivision", "arcade", "pinball",
      "board game", "toy", "doll", "action figure", "lego",
    ],
  },
  {
    category: "electronics",
    keywords: [
      "radio", "television", "tv", "reel-to-reel", "reel to reel", "turntable",
      "receiver", "amplifier", "amplifer", "speaker", "hi-fi", "hifi", "stereo",
      "camera", "polaroid", "rangefinder", "slr", "computer", "commodore",
      "macintosh", "trs-80", "tube", "record player", "8-track", "cassette deck",
    ],
  },
  {
    category: "instruments",
    keywords: [
      "guitar", "violin", "piano", "banjo", "mandolin", "accordion", "trumpet",
      "saxophone", "clarinet", "ukulele", "drum", "fiddle", "organ",
    ],
  },
  {
    category: "clocks",
    keywords: ["grandfather clock", "mantel clock", "wall clock", "cuckoo clock", "clock"],
  },
  {
    category: "lighting",
    keywords: ["lamp", "chandelier", "sconce", "lantern", "light fixture"],
  },
  {
    category: "silver",
    keywords: ["sterling", "silverware", "flatware", "silver plate", "holloware", "silverplate"],
  },
  {
    category: "ceramics_glass",
    keywords: [
      "pottery", "porcelain", "china", "crystal", "glassware", "vase", "figurine",
      "ceramic", "stoneware", "depression glass", "milk glass", "dish", "platter",
      "candlestick", "decanter", "punch bowl", "teapot", "wine glass", "goblet",
      "tumbler", "pitcher", "compote", "ashtray",
    ],
  },
  {
    category: "jewelry_watches",
    keywords: ["jewelry", "necklace", "ring", "bracelet", "brooch", "watch", "wristwatch", "pocket watch"],
  },
  {
    category: "art",
    keywords: [
      // "poster" deliberately excluded — it collides with "four-poster" (a bed).
      "painting", "print", "lithograph", "etching", "sculpture", "artwork",
      "framed art", "oil on canvas", "watercolor", "drawing", "statue", "statuette",
      "bust", "mirror", "tapestry", "marquetry",
    ],
  },
  {
    category: "beds",
    keywords: ["bed", "headboard", "footboard", "four-poster", "canopy bed"],
  },
  {
    category: "seating",
    keywords: [
      "sofa", "sectional", "loveseat", "couch", "armchair", "chair", "recliner",
      "settee", "bench", "stool", "ottoman", "chaise",
    ],
  },
  {
    category: "tables",
    keywords: ["table", "desk", "console table", "nightstand", "dining table", "coffee table"],
  },
  {
    category: "case_goods",
    keywords: [
      "dresser", "credenza", "armoire", "cabinet", "bureau", "sideboard",
      "buffet", "chest", "hutch", "bookcase", "wardrobe", "vanity",
    ],
  },
];

export function classifyCategory(line: string): Category {
  const padded = ` ${line.toLowerCase()} `;
  for (const { category, keywords } of CATEGORY_RULES) {
    if (keywords.some((k) => padded.includes(k))) return category;
  }
  return "other";
}

// Most-specific era signal in the line, or null. Decades beat named periods beat the
// generic "antique/vintage" floor, so "1950s mid-century" → "1950s".
export function inferEra(line: string): string | null {
  const t = line.toLowerCase();
  const decade = /\b(18|19|20)\d0s\b/.exec(t) ?? /\b(?:'|’)(\d0)s\b/.exec(t);
  if (decade) return decade[0].replace(/[’']/, "").trim();
  const circa = /\bcirca\s+(1[89]\d{2}|20\d{2})\b/.exec(t);
  if (circa) return `circa ${circa[1]}`;
  const named: Array<[RegExp, string]> = [
    [/\bmid[- ]century\b/, "mid-century"],
    [/\bart deco\b/, "Art Deco"],
    [/\bart nouveau\b/, "Art Nouveau"],
    [/\barts (?:&|and) crafts\b/, "Arts & Crafts"],
    [/\bvictorian\b/, "Victorian"],
    [/\bedwardian\b/, "Edwardian"],
    [/\bgeorgian\b/, "Georgian"],
    [/\bcolonial\b/, "Colonial"],
    [/\bantique\b/, "antique"],
    [/\bvintage\b/, "vintage"],
  ];
  for (const [re, label] of named) if (re.test(t)) return label;
  return null;
}

const PREMIUM_ERAS = new Set([
  "mid-century", "Art Deco", "Art Nouveau", "Arts & Crafts", "Victorian",
  "Edwardian", "Georgian", "antique",
]);

// Desirability ≠ identification confidence. A lexicon maker hit (a name a collector
// seeks) or a premium era signal lifts it to high; otherwise items the VLM bothered
// to list sit at med. Human Outcomes later override to gold (ADR 0015).
export function inferDesirability(makerCount: number, era: string | null): ItemConfidence {
  if (makerCount > 0) return "high";
  if (era && PREMIUM_ERAS.has(era)) return "high";
  return "med";
}

function mapConfidence(c: Confidence | null): ItemConfidence {
  if (c === "medium") return "med";
  if (c === "high" || c === "low") return c;
  return "med";
}

// Split a Finding's description into one ItemDraft per line. Deterministic (no extra
// inference): the VLM already emits one notable item per line. Re-running over the
// same finding yields the same drafts, so a lexicon-growth backfill is idempotent.
export function extractItems(input: {
  description: string;
  confidence: Confidence | null;
}): ItemDraft[] {
  const idConfidence = mapConfidence(input.confidence);
  const lines = input.description
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const makers = resolveMakers(line);
    const matchedLexicon = makers.map((m) => m.maker);
    const era = inferEra(line);
    return {
      maker: makers[0]?.maker ?? null,
      makerRaw: makers[0]?.raw ?? null,
      category: classifyCategory(line),
      era,
      desirability: inferDesirability(makers.length, era),
      matchedLexicon,
      itemDesc: line,
      source: makers.length > 0 ? "lexicon" : "vlm",
      idConfidence,
    };
  });
}
