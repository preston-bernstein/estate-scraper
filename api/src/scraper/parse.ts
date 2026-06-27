import { SKIP_IMAGE_PATTERNS } from "../lib/scraping.js";

export type ListingRef = {
  saleId: string;
  title: string;
  url: string;
};

const LISTING_HREF = /^\/([A-Z]{2})\/(.+)\/(\d{5})\/(\d+)$/;

export function parseListingLinks(html: string): ListingRef[] {
  const hrefPattern = /href="(\/[A-Z]{2}\/[^"]+\/\d{5}\/\d+)"/g;
  const seen = new Set<string>();
  const listings: ListingRef[] = [];

  for (const match of html.matchAll(hrefPattern)) {
    const href = match[1];
    if (!LISTING_HREF.test(href)) {
      continue;
    }

    const saleId = href.split("/").pop()!;
    if (seen.has(saleId)) {
      continue;
    }

    seen.add(saleId);
    listings.push({
      saleId,
      title: "",
      url: `https://www.estatesales.net${href}`,
    });
  }

  return listings;
}

export type SaleDetail = {
  saleId: string;
  title: string;
  url: string;
  startDate: string;
  endDate: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  imageUrls: string[];
};

function firstMatch(html: string, pattern: RegExp): string | null {
  return html.match(pattern)?.[1] ?? null;
}

function isoDateOnly(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.slice(0, 10);
}

export function parseSaleDetail(html: string, url: string): SaleDetail | null {
  const saleId = url.split("/").pop();
  if (!saleId) {
    return null;
  }

  const title =
    firstMatch(html, /<meta property="og:title" content="([^"]+)"/) ??
    firstMatch(html, /<title>([^<]+)<\/title>/) ??
    saleId;

  const startDate = isoDateOnly(firstMatch(html, /"startDate":"([^"]+)"/));
  const endDate = isoDateOnly(firstMatch(html, /"endDate":"([^"]+)"/));
  const address = firstMatch(html, /"addressLine1":"([^"]+)"/);
  const city = firstMatch(html, /"addressLocality":"([^"]+)"/);
  const state = firstMatch(html, /"addressRegion":"([^"]+)"/);
  const zip = firstMatch(html, /"postalCode":"([^"]+)"/);

  if (!startDate || !endDate || !address || !city || !state || !zip) {
    const missing = { startDate, endDate, address, city, state, zip };
    const absent = Object.entries(missing)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    console.error(`  [parse] missing fields: ${absent.join(", ")}`);
    return null;
  }

  const rawUrls = [
    ...html.matchAll(
      /https?:\/\/picturescdn\.estatesales\.net\/[^"' >]+\.(?:jpg|jpeg|png|webp)/gi,
    ),
  ].map((match) => match[0]);

  const imageUrls: string[] = [];
  const seenImages = new Set<string>();
  for (const imageUrl of rawUrls) {
    const lower = imageUrl.toLowerCase();
    if (SKIP_IMAGE_PATTERNS.some((pattern) => lower.includes(pattern))) {
      continue;
    }
    if (seenImages.has(imageUrl)) {
      continue;
    }
    seenImages.add(imageUrl);
    imageUrls.push(imageUrl);
  }

  return {
    saleId,
    title: title.replace(/\s*starts on.*$/i, "").trim(),
    url,
    startDate,
    endDate,
    address,
    city,
    state,
    zip,
    imageUrls,
  };
}
