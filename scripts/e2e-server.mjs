// Boots the real API (stub auth, production mode serving the stub UI build) against a
// fresh temp SQLite db seeded with known states, for Playwright e2e. Migrates + seeds
// BEFORE serving so tests never race an empty db.
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const apiDir = fileURLToPath(new URL("../api", import.meta.url));
const DB = "/tmp/estate-e2e.db";

process.env.DATABASE_URL = DB;
process.env.AUTH_MODE = "stub";
process.env.NODE_ENV = "production";
process.env.PORT = process.env.E2E_PORT ?? "4321";
process.env.THUMBNAIL_DIR = "/tmp/estate-e2e-thumbs";
process.env.HOME_ADDRESS = "1 Test St";
process.env.HOME_CITY = "Decatur";
process.env.HOME_STATE = "GA";
process.env.HOME_ZIP = "30033";
process.env.HOME_LAT = "33.8";
process.env.HOME_LON = "-84.26";

for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const now = new Date().toISOString();

const { runMigrations, db } = await import(pathToFileURL(`${apiDir}/dist/db/index.js`));
runMigrations(`${apiDir}/drizzle`);
const { sales, findings } = await import(pathToFileURL(`${apiDir}/dist/db/schema.js`));

const base = { url: "https://example.com/s", address: "5 Oak St", city: "Decatur", state: "GA", zip: "30033", lat: 33.8, lon: -84.26, distanceMiles: 8, scrapedAt: now };

db.insert(sales).values([
  { saleId: "E2E-UP", title: "E2E Upcoming Estate", startDate: iso(1), endDate: iso(3), ...base },
  { saleId: "E2E-PAST", title: "E2E Past Estate", startDate: iso(-5), endDate: iso(-3), ...base },
]).run();

db.insert(findings).values([
  { saleId: "E2E-UP", imageUrl: "https://example.com/a.jpg", description: "Stickley oak armchair", scrapedAt: now, confidence: "high" },
  { saleId: "E2E-UP", imageUrl: "https://example.com/b.jpg", description: "brass floor lamp", scrapedAt: now, confidence: "medium" },
  { saleId: "E2E-PAST", imageUrl: "https://example.com/c.jpg", description: "walnut credenza", scrapedAt: now, confidence: "high" },
]).run();

// index.js runMigrations() uses "./drizzle" relative to cwd; chdir so it resolves.
process.chdir(apiDir);
await import(pathToFileURL(`${apiDir}/dist/index.js`));
console.log(`[e2e] seeded + serving on :${process.env.PORT}`);
