export type HuntMatchCount = {
  huntName: string;
  count: number;
};

export type SaleSummary = {
  saleId: string;
  title: string;
  url: string;
  startDate: string;
  endDate: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lon: number;
  distanceMiles: number;
  thumbnailUrl: string | null;
  thumbUrl: string | null;
  thumbnailDescription: string | null;
  huntMatchCounts: HuntMatchCount[];
  totalMatchedFindings: number;
};

export type Finding = {
  id: number;
  saleId: string;
  imageUrl: string;
  thumbUrl: string | null;
  description: string;
  scrapedAt: string;
  matched: boolean;
};

export type Hunt = {
  id: number;
  ownerSub: string;
  name: string;
  keywords: string[];
  createdAt: string;
};

export type StatusResponse = {
  lastScannedAt: string | null;
  scanFailed: boolean;
  scanRunning?: boolean;
  scanPhase?: string;
  scanMessage?: string;
};

export type MeResponse = {
  sub: string;
  canTriggerScan: boolean;
};

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

export type SettingsResponse = {
  radiusMiles: number;
};

export type AllItem = {
  id: number;
  saleId: string;
  imageUrl: string;
  thumbUrl: string | null;
  description: string;
  confidence: string | null;
  saleTitle: string;
  distanceMiles: number;
  endDate: string;
};

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

export type DiscoverResponse = {
  rankedSales: RankedSale[];
  standouts: Standout[];
};

export type ScanStatusEvent = {
  phase: string;
  running: boolean;
  failed: boolean;
  message: string;
  lastScannedAt: string | null;
};

// Exhaustive over every event type the server actually emits (scan/index.ts's
// writer.pushEvent wrapper events, plus every VisionEvent variant it forwards
// verbatim). No catch-all member: a `{ type: string }` fallback would overlap every
// other member and defeat discriminated-union narrowing on `e.type === "..."`
// checks — functionally `any` at this boundary. analyzed_image/image_result/done
// carry fields the UI doesn't read yet, so only `type` is declared for them.
export type ScanEvent =
  | { type: "phase"; phase: string; msg: string }
  | { type: "scrape_done"; count: number }
  | { type: "sale_start"; saleIdx: number; totalSales: number; saleId: string; title: string; total: number; originalTotal: number }
  | { type: "progress"; saleId: string; done: number; total: number; found: number; errors: number }
  | { type: "finding"; saleId: string; description: string; confidence: string | null }
  | { type: "sale_skip"; saleId: string; title: string; imagesAnalyzed: number; totalImages: number }
  | { type: "oracle_request"; saleId: string; title: string; saleScore: number }
  | { type: "sale_done"; saleId: string; imagesProcessed: number; imagesWithFindings: number; analysisPhase: string; totalImages: number; saleScore: number }
  | { type: "analyzed_image" }
  | { type: "image_result" }
  | { type: "done" }
  | { type: "error"; msg: string };

export type AnalyzedImage = {
  id: number;
  imageUrl: string;
  thumbnailPath: string | null;
  positionPct: number | null;
  visionResponse: string | null;
  hasFindings: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
};
