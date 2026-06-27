import type { Category, CategoryStats, ImageResult, LabeledImage, ModelPromptResult, RunSummary } from "./types.js";

// Color words that indicate a specific furniture description
const COLOR_WORDS = new Set([
  "white", "black", "brown", "gray", "grey", "red", "blue", "green",
  "tan", "beige", "cream", "navy", "burgundy", "teal", "yellow",
  "orange", "walnut", "oak", "cherry", "mahogany", "ebony", "ivory",
  "charcoal", "taupe", "camel", "cognac",
]);

// Material words that indicate a specific furniture description
const MATERIAL_WORDS = new Set([
  "leather", "velvet", "linen", "fabric", "upholstered", "suede",
  "microfiber", "chenille", "tweed", "wool", "cotton", "silk",
  "wood", "wooden", "oak", "walnut", "mahogany", "teak", "pine",
  "cherry", "maple", "birch", "bamboo", "rattan", "wicker",
]);

// Era/style substrings — any match counts as specific
const ERA_SUBSTRINGS = [
  "mid-century", "victorian", "arts & crafts", "art deco", "art nouveau",
  "mission", "craftsman", "shaker", "chippendale", "queen anne", "edwardian",
  "colonial", "georgian", "regency", "empire", "baroque", "vintage", "antique",
  "circa",
];

// Condition/furniture brand substrings — any match counts as specific
const VALUE_SUBSTRINGS = [
  "stickley", "henredon", "baker ", "drexel", "broyhill", "lane ", "tiffany",
  "thomasville", "ethan allen", "heywood",
  "label visible", "maker's mark", "signed",
  "excellent condition", "good condition", "fair condition",
  "scratches", "veneer", "missing hardware", "patina", "distressed", "refinished",
];

// Electronics brand/type substrings — specificity for electronics/games category
const ELECTRONICS_SUBSTRINGS = [
  "atari", "sega", "nintendo", "commodore", "colecovision", "intellivision",
  "polaroid", "pioneer", "zenith", "rca ", "sony", "panasonic", "marantz",
  "console", "cartridge", "arcade", "cabinet", "reel-to-reel", "turntable",
  "amplifier", "receiver", "tube radio", "tube tv", "tube television",
  "apple ii", "trs-80",
];

// Kitsch specificity substrings — subject + medium detail
const KITSCH_SUBSTRINGS = [
  "velvet", "paint-by-number", "taxidermy", "ceramic", "flamingo", "rooster",
  "poodle", "tiki", "lava lamp", "snow globe", "outsider", "camp", "novelty",
  "figurine", "kitschy",
];

const VERBOSE_PREFIXES = /^(the image|i can|this image|in this image|the photo)/i;

// Mirror of production hasFindings — must stay in sync with api/src/vision/index.ts
export function hasFindings(response: string): boolean {
  const trimmed = response.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toUpperCase();
  if (normalized === "NOTHING") return false;

  if (trimmed.length > 1000) return false;
  if (VERBOSE_PREFIXES.test(trimmed)) return false;

  const lines = normalized.split(/\r?\n/).filter((line) => line.trim());
  const junk = lines.filter(
    (line) =>
      line.endsWith(": 0") ||
      line.endsWith(": NONE") ||
      line.endsWith(": NONE VISIBLE"),
  ).length;

  return junk < lines.length;
}

export function scoreKeywordHit(raw: string, keywords: string[]): boolean {
  const lower = raw.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

export function scoreSpecificity(raw: string): boolean | null {
  const lower = raw.toLowerCase();
  const words = lower.split(/\W+/);
  const hasColor = words.some((w) => COLOR_WORDS.has(w));
  const hasMaterial = words.some((w) => MATERIAL_WORDS.has(w));
  const hasEra = ERA_SUBSTRINGS.some((s) => lower.includes(s));
  const hasValue = VALUE_SUBSTRINGS.some((s) => lower.includes(s));
  const hasElectronics = ELECTRONICS_SUBSTRINGS.some((s) => lower.includes(s));
  const hasKitsch = KITSCH_SUBSTRINGS.some((s) => lower.includes(s));
  return hasColor || hasMaterial || hasEra || hasValue || hasElectronics || hasKitsch;
}

export function scoreFormatOk(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length > 1000) return false;
  if (VERBOSE_PREFIXES.test(trimmed)) return false;
  return true;
}

const SPECIFICITY_CATEGORIES: Category[] = ["seating", "bed", "electronics", "kitsch"];

export function scoreResult(label: LabeledImage, raw: string, durationMs: number, error: string | null): ImageResult {
  const detected = hasFindings(raw);
  const keywordHit = label.expectNothing ? true : scoreKeywordHit(raw, label.expectedKeywords);
  const specific = SPECIFICITY_CATEGORIES.includes(label.category) ? scoreSpecificity(raw) : null;
  const formatOk = scoreFormatOk(raw);

  return {
    label,
    raw,
    detected,
    keywordHit,
    specific,
    formatOk,
    durationMs,
    error,
  };
}

export function summarize(run: ModelPromptResult): RunSummary {
  const { model, promptName, results } = run;

  const nonErrorResults = results.filter((r) => !r.error);
  const totalImages = nonErrorResults.length;

  // Detection accuracy: correct means detected===!expectNothing
  const detectionCorrect = nonErrorResults.filter(
    (r) => r.detected === !r.label.expectNothing,
  ).length;

  // Keyword recall: only non-nothing labels
  const keywordEligible = nonErrorResults.filter((r) => !r.label.expectNothing);
  const keywordHits = keywordEligible.filter((r) => r.keywordHit).length;

  // Specificity: seating/bed only
  const specificityEligible = nonErrorResults.filter((r) => r.specific !== null);
  const specificityHits = specificityEligible.filter((r) => r.specific).length;

  const formatOk = nonErrorResults.filter((r) => r.formatOk).length;
  const avgDurationMs =
    nonErrorResults.length > 0
      ? nonErrorResults.reduce((sum, r) => sum + r.durationMs, 0) / nonErrorResults.length
      : 0;

  // Per-category breakdown
  const categories = [...new Set(results.map((r) => r.label.category))] as Category[];
  const byCategory: CategoryStats[] = categories.map((cat) => {
    const catResults = nonErrorResults.filter((r) => r.label.category === cat);
    const specificEligible = catResults.filter((r) => r.specific !== null);
    return {
      category: cat,
      total: catResults.length,
      detected: catResults.filter((r) => r.detected === !r.label.expectNothing).length,
      keywordHit: catResults.filter((r) => r.keywordHit).length,
      specific: specificEligible.filter((r) => r.specific).length,
      specificTotal: specificEligible.length,
      formatOk: catResults.filter((r) => r.formatOk).length,
    };
  });

  return {
    model,
    promptName,
    totalImages,
    detectionAcc: totalImages > 0 ? detectionCorrect / totalImages : 0,
    keywordRecall: keywordEligible.length > 0 ? keywordHits / keywordEligible.length : 0,
    specificityRate: specificityEligible.length > 0 ? specificityHits / specificityEligible.length : 0,
    formatCompliance: totalImages > 0 ? formatOk / totalImages : 0,
    avgDurationMs,
    byCategory,
  };
}
