export const BASE_URL = "https://www.estatesales.net";
export const IMG_CDN = "picturescdn.estatesales.net";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required — see api/.env.example`);
  return v;
}

export const HOME = {
  address: requireEnv("HOME_ADDRESS"),
  city: requireEnv("HOME_CITY"),
  state: requireEnv("HOME_STATE"),
  zip: requireEnv("HOME_ZIP"),
  lat: Number(requireEnv("HOME_LAT")),
  lon: Number(requireEnv("HOME_LON")),
};

export const DEFAULT_RADIUS_MILES = 30;

export const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: `${BASE_URL}/`,
} as const;

export const SKIP_IMAGE_PATTERNS = [
  "logo",
  "icon",
  "orglogo",
  "avatar",
  "pixel",
  "blank",
  "badge",
];

export const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ?? "estate-scraper/1.0 (home-lab)";

export const SCAN_STATE_PATH =
  process.env.SCAN_STATE_PATH ?? "./data/scan-state.json";

export const METRO_LISTING_URL = `${BASE_URL}/GA/Atlanta`;
