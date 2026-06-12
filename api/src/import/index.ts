import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMigrations } from "../db/index.js";
import { distanceFromHome, geocodeAddress, nominatimDelay } from "../lib/geo.js";
import { fetchText } from "../lib/http.js";
import { parseSaleDetail } from "../scraper/parse.js";
import {
  getProcessedImageUrls,
  insertFinding,
  upsertSale,
} from "../scan/persist.js";
import type { ScrapedSale } from "../scraper/index.js";

type LegacyFinding = {
  image_url: string;
  findings: string;
};

type LegacySale = {
  sale_id: string;
  title: string;
  url: string;
  findings: LegacyFinding[];
};

async function ensureSaleRecord(
  entry: LegacySale,
  scrapedAt: string,
): Promise<ScrapedSale | null> {
  const html = await fetchText(entry.url);
  if (!html) {
    console.error(`  [skip] Could not fetch ${entry.url}`);
    return null;
  }

  const detail = parseSaleDetail(html, entry.url);
  if (!detail) {
    console.error(`  [skip] Could not parse ${entry.url}`);
    return null;
  }

  await nominatimDelay();
  const geocoded = await geocodeAddress({
    address: detail.address,
    city: detail.city,
    state: detail.state,
    zip: detail.zip,
  });

  if (!geocoded) {
    console.error(`  [skip] Geocode failed for ${detail.address}`);
    return null;
  }

  const sale: ScrapedSale = {
    ...detail,
    title: entry.title || detail.title,
    lat: geocoded.lat,
    lon: geocoded.lon,
    distanceMiles: distanceFromHome(geocoded.lat, geocoded.lon),
  };

  await upsertSale(sale, scrapedAt);
  return sale;
}

async function seedDefaultHunts() {
  const { db } = await import("../db/index.js");
  const { hunts } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { DEV_USER_SUB } = await import("../types/env.js");

  const defaults = [
    { name: "furniture", keywords: ["chair", "table", "dresser", "cabinet", "Stickley"] },
    { name: "silver", keywords: ["silver", "sterling", "candlestick"] },
    { name: "art", keywords: ["painting", "lithograph", "art", "print"] },
  ];

  for (const hunt of defaults) {
    const existing = await db
      .select()
      .from(hunts)
      .where(eq(hunts.ownerSub, DEV_USER_SUB));

    if (existing.some((row) => row.name === hunt.name)) {
      continue;
    }

    await db.insert(hunts).values({
      ownerSub: DEV_USER_SUB,
      name: hunt.name,
      keywords: hunt.keywords,
      createdAt: new Date().toISOString(),
    });
  }

  console.log("Seeded default Hunts for dev-user.");
}

async function main() {
  runMigrations();

  const args = process.argv.slice(2);
  let filePath = resolve(process.cwd(), "../findings.json");
  let seedHunts = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--file") {
      filePath = resolve(process.cwd(), args[++index]!);
    } else if (arg === "--seed-hunts") {
      seedHunts = true;
    }
  }

  const raw = readFileSync(filePath, "utf8");
  const entries = JSON.parse(raw) as LegacySale[];
  const scrapedAt = new Date().toISOString();
  const processedUrls = await getProcessedImageUrls();

  let salesImported = 0;
  let findingsImported = 0;
  let findingsSkipped = 0;

  for (const [index, entry] of entries.entries()) {
    console.log(`[${index + 1}/${entries.length}] ${entry.sale_id}`);

    const sale = await ensureSaleRecord(entry, scrapedAt);
    if (!sale) {
      continue;
    }

    salesImported += 1;

    for (const finding of entry.findings) {
      if (processedUrls.has(finding.image_url)) {
        findingsSkipped += 1;
        continue;
      }

      await insertFinding(
        entry.sale_id,
        finding.image_url,
        finding.findings,
        scrapedAt,
      );
      processedUrls.add(finding.image_url);
      findingsImported += 1;
    }
  }

  if (seedHunts) {
    await seedDefaultHunts();
  }

  console.log(
    `\nImport complete: ${salesImported} sales, ${findingsImported} findings (${findingsSkipped} skipped).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
