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

export type SettingsResponse = {
  radiusMiles: number;
};
