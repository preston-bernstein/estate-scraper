export type Category =
  | "seating"      // sofas, sectionals, loveseats
  | "bed"          // beds, headboards
  | "case_goods"   // dressers, credenzas, armoires
  | "collectible"  // vintage items, clocks, lamps, art, named brands
  | "electronics"  // vintage games, consoles, radios, hi-fi, cameras
  | "kitsch"       // velvet paintings, ceramic novelties, taxidermy, camp items
  | "nothing";     // model should return NOTHING / empty items array

export type LabeledImage = {
  url: string;
  category: Category;
  expectedKeywords: string[];
  expectNothing: boolean;
  notes: string;
};

export type ImageResult = {
  label: LabeledImage;
  raw: string;          // raw string from model (post-parse if structured)
  detected: boolean;
  keywordHit: boolean;
  specific: boolean | null;
  formatOk: boolean;
  durationMs: number;
  error: string | null;
};

export type ModelPromptResult = {
  model: string;
  promptName: string;
  results: ImageResult[];
};

export type CategoryStats = {
  category: Category;
  total: number;
  detected: number;
  keywordHit: number;
  specific: number;
  specificTotal: number;
  formatOk: number;
};

export type RunSummary = {
  model: string;
  promptName: string;
  totalImages: number;
  detectionAcc: number;
  keywordRecall: number;
  specificityRate: number;
  formatCompliance: number;
  avgDurationMs: number;
  byCategory: CategoryStats[];
};
