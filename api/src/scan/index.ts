import { runMigrations } from "../db/index.js";
import { scrapeWithinRadius } from "../scraper/index.js";
import { checkModelAvailable, processSalesStream } from "../vision/index.js";
import {
  getProcessedImageUrls,
  getScanRadiusMiles,
  insertFindingsBatch,
  upsertSale,
} from "./persist.js";
import { ScanStateWriter } from "./state.js";

type ScanOptions = {
  radiusMiles?: number;
  maxSales?: number;
  maxImages?: number;
  skipVision?: boolean;
};

function parseArgs(argv: string[]): ScanOptions {
  const options: ScanOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--max-sales") {
      options.maxSales = Number(argv[++index]);
    } else if (arg === "--max-images") {
      options.maxImages = Number(argv[++index]);
    } else if (arg === "--radius") {
      options.radiusMiles = Number(argv[++index]);
    } else if (arg === "--skip-vision") {
      options.skipVision = true;
    }
  }

  return options;
}

async function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  const radiusMiles = args.radiusMiles ?? (await getScanRadiusMiles());
  const writer = new ScanStateWriter();
  const scrapedAt = new Date().toISOString();

  try {
    writer.setPhase("scraping", `Scraping sales within ${radiusMiles} miles…`);
    writer.pushEvent({
      type: "phase",
      phase: "scraping",
      msg: `Scraping sales within ${radiusMiles} miles…`,
    });

    const scrapedSales = await scrapeWithinRadius({
      radiusMiles,
      maxSales: args.maxSales,
      onProgress: (message) => console.log(message),
    });

    writer.pushEvent({
      type: "scrape_done",
      count: scrapedSales.length,
    });

    if (scrapedSales.length === 0) {
      writer.finish("No sales found within radius.");
      console.log("No sales found within radius.");
      return;
    }

    for (const sale of scrapedSales) {
      await upsertSale(sale, scrapedAt);
    }

    if (args.skipVision) {
      writer.finish(
        `Scrape complete — ${scrapedSales.length} sales within radius.`,
      );
      console.log(`Saved ${scrapedSales.length} sales (vision skipped).`);
      return;
    }

    if (!(await checkModelAvailable())) {
      throw new Error("Ollama model unavailable.");
    }

    writer.setPhase("analyzing", "Running vision analysis…");
    writer.pushEvent({
      type: "phase",
      phase: "analyzing",
      msg: "Running vision analysis…",
    });

    const skipUrls = await getProcessedImageUrls();
    let totalFindings = 0;
    let totalImages = 0;

    let currentSaleId: string | null = null;
    const saleBuffer: Array<{ imageUrl: string; description: string }> = [];

    for await (const event of processSalesStream(scrapedSales, {
      maxImages: args.maxImages,
      skipUrls,
    })) {
      writer.pushEvent(event);

      if (event.type === "sale_start") {
        currentSaleId = scrapedSales[event.saleIdx].saleId;
        saleBuffer.length = 0;
        console.log(
          `\n[${event.saleIdx + 1}/${event.totalSales}] ${event.title.slice(0, 60)}`,
        );
        console.log(`  ${event.total} images…`);
      } else if (event.type === "finding") {
        totalFindings += 1;
        saleBuffer.push({ imageUrl: event.imageUrl, description: event.description });
        console.log(`  FOUND: ${event.description.slice(0, 80)}`);
      } else if (event.type === "sale_done") {
        totalImages += event.imagesProcessed;
        console.log(
          `  Done: ${event.imagesWithFindings} findings / ${event.imagesProcessed} images`,
        );
        if (currentSaleId !== null) {
          await insertFindingsBatch(currentSaleId, saleBuffer, scrapedAt);
        }
      }
    }

    writer.finish(
      `Done — ${totalFindings} findings across ${totalImages} images.`,
    );
    console.log(
      `\nScan complete: ${totalFindings} findings across ${totalImages} images.`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown scan error";
    writer.pushEvent({ type: "error", msg: message });
    writer.finish(message, true);
    console.error(message);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
