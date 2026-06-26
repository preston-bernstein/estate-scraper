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
  thumbnailDescription: string | null;
  huntMatchCounts: HuntMatchCount[];
  totalMatchedFindings: number;
};

export type Finding = {
  id: number;
  saleId: string;
  imageUrl: string;
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

export type DiscoverResponse = {
  rankedSales: RankedSale[];
  standouts: Standout[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
};
