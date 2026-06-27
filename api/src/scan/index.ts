import { runMigrations } from "../db/index.js";
import { scrapeWithinRadius } from "../scraper/index.js";
import { callOracle } from "../vision/oracle.js";
import { checkModelAvailable, processSalesStream } from "../vision/index.js";
import type { Confidence } from "../vision/index.js";
import {
  getProcessedImageUrls,
  getScanRadiusMiles,
  insertFindingsBatch,
  updateSaleAnalysis,
  updateSaleOracle,
  upsertSale,
} from "./persist.js";
import { ScanStateWriter } from "./state.js";

type ScanOptions = {
  radiusMiles?: number;
  maxSales?: number;
  maxImages?: number;
  skipVision?: boolean;
  dryRun?: boolean;
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
    } else if (arg === "--dry-run") {
      options.dryRun = true;
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

    writer.pushEvent({ type: "scrape_done", count: scrapedSales.length });

    if (scrapedSales.length === 0) {
      writer.finish("No sales found within radius.");
      console.log("No sales found within radius.");
      return;
    }

    for (const sale of scrapedSales) {
      await upsertSale(sale, scrapedAt);
    }

    if (args.skipVision) {
      writer.finish(`Scrape complete — ${scrapedSales.length} sales within radius.`);
      console.log(`Saved ${scrapedSales.length} sales (vision skipped).`);
      return;
    }

    if (!(await checkModelAvailable())) {
      throw new Error("Ollama model unavailable.");
    }

    writer.setPhase("analyzing", "Running vision analysis…");
    writer.pushEvent({ type: "phase", phase: "analyzing", msg: "Running vision analysis…" });

    const skipUrls = await getProcessedImageUrls();
    let totalFindings = 0;
    let totalImages = 0;

    let currentSaleId: string | null = null;
    let currentSaleTitle = "";
    let currentSaleAddress = "";
    let saleBuffer: Array<{
      imageUrl: string;
      description: string;
      confidence: Confidence | null;
      imagePositionPct: number;
    }> = [];

    for await (const event of processSalesStream(scrapedSales, {
      maxImages: args.maxImages,
      dryRun: args.dryRun,
      skipUrls,
    })) {
      writer.pushEvent(event);

      if (event.type === "sale_start") {
        const sale = scrapedSales[event.saleIdx]!;
        currentSaleId = sale.saleId;
        currentSaleTitle = sale.title;
        currentSaleAddress = `${sale.address}, ${sale.city}, ${sale.state}`;
        saleBuffer = [];
        console.log(
          `\n[${event.saleIdx + 1}/${event.totalSales}] ${event.title.slice(0, 60)}`,
        );
        const reduction = event.originalTotal - event.total;
        const suffix = reduction > 0 ? ` (${event.originalTotal} → ${event.total} after dedup/prefilter)` : "";
        console.log(`  ${event.total} images…${suffix}`);
      } else if (event.type === "finding") {
        totalFindings++;
        saleBuffer.push({
          imageUrl: event.imageUrl,
          description: event.description,
          confidence: event.confidence,
          imagePositionPct: event.imagePositionPct,
        });
        const confLabel = event.confidence ? ` [${event.confidence}]` : "";
        console.log(`  FOUND${confLabel}: ${event.description.slice(0, 80)}`);
      } else if (event.type === "sale_skip") {
        console.log(
          `  SKIP: nothing found in ${event.imagesAnalyzed} images analyzed of ${event.totalImages} total`,
        );
        if (currentSaleId) {
          await updateSaleAnalysis(currentSaleId, event.imagesAnalyzed, "EARLY_STOP");
        }
      } else if (event.type === "oracle_request") {
        console.log(
          `  ORACLE: uncertain zone (score ${event.saleScore.toFixed(2)}) — calling remote model…`,
        );
        const result = await callOracle(event.title, event.address, event.imageUrls);
        if (result && currentSaleId) {
          await updateSaleOracle(
            currentSaleId,
            result.score,
            result.reasoning,
            result.shouldAttend,
            result.topItems,
          );
          const attendLabel = result.shouldAttend ? "ATTEND" : "SKIP";
          console.log(
            `  ORACLE [${attendLabel}] score ${result.score}/5 — ${result.reasoning.slice(0, 80)}`,
          );
        }
      } else if (event.type === "sale_done") {
        totalImages += event.imagesProcessed;
        console.log(
          `  Done [${event.analysisPhase}]: ${event.imagesWithFindings} findings / ${event.imagesProcessed} analyzed (${event.totalImages} total) — score ${event.saleScore.toFixed(2)}`,
        );
        if (currentSaleId) {
          await insertFindingsBatch(currentSaleId, saleBuffer, scrapedAt);
          if (event.analysisPhase !== "EARLY_STOP") {
            await updateSaleAnalysis(currentSaleId, event.imagesProcessed, event.analysisPhase);
          }
        }
      }
    }

    writer.finish(`Done — ${totalFindings} findings across ${totalImages} images.`);
    console.log(`\nScan complete: ${totalFindings} findings across ${totalImages} images.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown scan error";
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
