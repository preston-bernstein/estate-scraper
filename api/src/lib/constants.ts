export const BASE_URL = "https://www.estatesales.net";
export const IMG_CDN = "picturescdn.estatesales.net";

export const HOME = {
  address: "YOUR_HOME_ADDRESS",
  city: "Decatur",
  state: "GA",
  zip: "YOUR_HOME_ZIP",
  lat: 0.0,
  lon: 0.0,
} as const;

export const DEFAULT_RADIUS_MILES = 30;

export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://YOUR_DESKTOP_IP:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llava:13b";
export const VISION_WORKERS = 6;

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

export const VISION_PROMPT =
  "You are scanning an estate sale photo for valuable items. Respond with a short list of the specific valuable objects you actually see. Only name objects physically visible in the image. Do NOT list categories, do NOT say 'none', do NOT use key:value format. If nothing valuable is visible, respond with exactly one word: NOTHING.";

export const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ?? "estate-scraper/1.0 (home-lab)";

export const SCAN_STATE_PATH =
  process.env.SCAN_STATE_PATH ?? "./data/scan-state.json";

export const METRO_LISTING_URL = `${BASE_URL}/GA/Atlanta`;
