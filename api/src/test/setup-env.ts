// Vitest global setup: provide the HOME_* env vars that lib/scraping.ts reads at
// module load (requireEnv throws otherwise). Tests don't hit the network or geocode;
// these are placeholders so the import chain (vision → http → scraping) loads.
process.env.HOME_ADDRESS ??= "1 Test St";
process.env.HOME_CITY ??= "Testville";
process.env.HOME_STATE ??= "GA";
process.env.HOME_ZIP ??= "30000";
process.env.HOME_LAT ??= "33.0";
process.env.HOME_LON ??= "-84.0";
