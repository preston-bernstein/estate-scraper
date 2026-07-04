import { HOME, NOMINATIM_USER_AGENT } from "./scraping.js";

const EARTH_RADIUS_MILES = 3958.8;

function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

export function distanceFromHome(lat: number, lon: number): number {
  return haversineMiles(HOME.lat, HOME.lon, lat, lon);
}

export type GeocodedAddress = {
  lat: number;
  lon: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rate-limits itself to 1 req/s per Nominatim policy.
async function nominatimQuery(query: string): Promise<GeocodedAddress | null> {
  await sleep(1100);

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
  });

  if (!response.ok) return null;

  const results = (await response.json()) as Array<{ lat: string; lon: string }>;
  const match = results[0];
  if (!match) return null;

  return { lat: Number(match.lat), lon: Number(match.lon) };
}

export async function geocodeAddress(parts: {
  address: string;
  city: string;
  state: string;
  zip: string;
}): Promise<GeocodedAddress | null> {
  const fullQuery = `${parts.address.trim()}, ${parts.city}, ${parts.state} ${parts.zip}`;
  const result = await nominatimQuery(fullQuery);
  if (result) return result;

  // Nominatim often misses residential US addresses; fall back to zip centroid.
  return nominatimQuery(`${parts.zip}, ${parts.state}, USA`);
}
