import { METRO_LISTING_URL } from "../lib/constants.js";
import { distanceFromHome, geocodeAddress } from "../lib/geo.js";
import { fetchText, politeDelay } from "../lib/http.js";
import { parseListingLinks, parseSaleDetail, type SaleDetail } from "./parse.js";

export type ScrapedSale = SaleDetail & {
  lat: number;
  lon: number;
  distanceMiles: number;
};

export type ScrapeOptions = {
  radiusMiles: number;
  maxSales?: number;
  onProgress?: (message: string) => void;
};

export async function scrapeWithinRadius(
  options: ScrapeOptions,
): Promise<ScrapedSale[]> {
  const { radiusMiles, maxSales, onProgress } = options;

  onProgress?.(`Fetching listings: ${METRO_LISTING_URL}`);
  const listingHtml = await fetchText(METRO_LISTING_URL);
  if (!listingHtml) {
    throw new Error("Failed to load metro listing page.");
  }

  const listings = parseListingLinks(listingHtml);
  onProgress?.(`Found ${listings.length} sales on metro page.`);

  const scraped: ScrapedSale[] = [];
  const limit = maxSales ?? listings.length;

  for (const [index, listing] of listings.slice(0, limit).entries()) {
    onProgress?.(
      `[${index + 1}/${Math.min(listings.length, limit)}] ${listing.saleId}`,
    );

    await politeDelay();
    const detailHtml = await fetchText(listing.url);
    if (!detailHtml) {
      continue;
    }

    const detail = parseSaleDetail(detailHtml, listing.url);
    if (!detail) {
      console.error(`  [skip] Could not parse detail page for ${listing.url}`);
      continue;
    }

    const geocoded = await geocodeAddress({
      address: detail.address,
      city: detail.city,
      state: detail.state,
      zip: detail.zip,
    });

    if (!geocoded) {
      console.error(`  [skip] Geocode failed for ${detail.address}`);
      continue;
    }

    const distanceMiles = distanceFromHome(geocoded.lat, geocoded.lon);
    if (distanceMiles > radiusMiles) {
      onProgress?.(`  -> outside radius (${distanceMiles.toFixed(1)} mi)`);
      continue;
    }

    onProgress?.(
      `  -> ${detail.imageUrls.length} images, ${distanceMiles.toFixed(1)} mi`,
    );

    scraped.push({
      ...detail,
      lat: geocoded.lat,
      lon: geocoded.lon,
      distanceMiles,
    });

    await politeDelay();
  }

  return scraped;
}
