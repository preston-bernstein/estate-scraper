import { HOME } from "./constants.js";

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(
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

export async function geocodeAddress(parts: {
  address: string;
  city: string;
  state: string;
  zip: string;
}): Promise<GeocodedAddress | null> {
  const query = `${parts.address}, ${parts.city}, ${parts.state} ${parts.zip}`;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        process.env.NOMINATIM_USER_AGENT ?? "estate-scraper/1.0 (home-lab)",
    },
  });

  if (!response.ok) {
    return null;
  }

  const results = (await response.json()) as Array<{ lat: string; lon: string }>;
  const match = results[0];
  if (!match) {
    return null;
  }

  return {
    lat: Number(match.lat),
    lon: Number(match.lon),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function nominatimDelay(): Promise<void> {
  await sleep(1100);
}
