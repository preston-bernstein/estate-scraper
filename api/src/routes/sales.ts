import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readScanEvents, readScanState } from "../scan/state.js";
import { startScan } from "../lib/scan-runner.js";
import { parsePositiveIntParam } from "../lib/params.js";
import { scanOwnerSub, type AppEnv } from "../types/env.js";
import {
  getLastScannedAt,
  getOutcome,
  getSaleDetail,
  getSaleImages,
  getThumbnailPath,
  listAllFindings,
  listAllSales,
  listPastSales,
  listUpcomingSales,
  recordOutcome,
  searchFindings,
} from "../services/sales.js";

export const salesRoutes = new Hono<AppEnv>();

salesRoutes.get("/", async (c) => {
  const ownerSub = c.get("userSub");
  const result = await listUpcomingSales(ownerSub);
  return c.json(result);
});

salesRoutes.get("/history", async (c) => {
  const ownerSub = c.get("userSub");
  const result = await listPastSales(ownerSub);
  return c.json(result);
});

// Ungated: every sale, no date/Hunt filter. Registered before "/:id" so it isn't
// captured as a sale id.
salesRoutes.get("/all", async (c) => {
  const ownerSub = c.get("userSub");
  return c.json(await listAllSales(ownerSub));
});

salesRoutes.get("/:id", async (c) => {
  const ownerSub = c.get("userSub");
  const detail = await getSaleDetail(ownerSub, c.req.param("id"));

  if (!detail) {
    return c.json({ error: "Sale not found" }, 404);
  }

  return c.json(detail);
});

salesRoutes.get("/:id/images", async (c) => {
  const imgs = await getSaleImages(c.req.param("id"));
  return c.json({ images: imgs });
});

salesRoutes.get("/:id/outcome", async (c) => {
  const ownerSub = c.get("userSub");
  const outcome = await getOutcome(c.req.param("id"), ownerSub);
  return c.json({ outcome });
});

salesRoutes.post("/:id/outcome", async (c) => {
  const ownerSub = c.get("userSub");
  const saleId = c.req.param("id");
  const body = await c.req.json<{
    attended: boolean;
    outcome: "good" | "meh" | "waste";
    notes?: string;
  }>();

  if (!["good", "meh", "waste"].includes(body.outcome)) {
    return c.json({ error: "outcome must be good | meh | waste" }, 400);
  }

  await recordOutcome(saleId, ownerSub, body.attended, body.outcome, body.notes ?? null);
  return c.json({ ok: true });
});

export const findingsRoutes = new Hono<AppEnv>();

// Flat feed of every Finding across all sales — the "all images" grid.
findingsRoutes.get("/all", async (c) => {
  return c.json(await listAllFindings());
});

findingsRoutes.get("/", async (c) => {
  const q = c.req.query("q") ?? "";
  const keywords = q
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const results = await searchFindings(keywords);
  return c.json({ findings: results });
});

// Public (mounted outside /api/*): serves the durable saved thumbnail by image id.
// Public so plain <img> tags work (they can't carry the Bearer token); these are
// downscaled copies of already-public listing photos. 404 → client falls back to the
// CDN url, then a placeholder.
export const thumbsRoutes = new Hono();

thumbsRoutes.get("/:id", async (c) => {
  const id = parsePositiveIntParam(c.req.param("id"));
  if (id === null) return c.body(null, 400);
  const path = await getThumbnailPath(id);
  if (!path) return c.body(null, 404);
  try {
    const buf = await readFile(path);
    return c.body(buf, 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=604800",
    });
  } catch {
    return c.body(null, 404);
  }
});

export const statusRoutes = new Hono();

statusRoutes.get("/", async (c) => {
  const lastScannedAt = await getLastScannedAt();
  const scanState = readScanState();

  return c.json({
    lastScannedAt,
    scanFailed: scanState.failed,
    scanRunning: scanState.running,
    scanPhase: scanState.phase,
    scanMessage: scanState.message,
  });
});

export const scanRoutes = new Hono<AppEnv>();

scanRoutes.post("/start", async (c) => {
  const owner = scanOwnerSub();
  if (!owner || c.get("userSub") !== owner) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const result = startScan();
  return c.json(result, result.started ? 200 : 409);
});

scanRoutes.get("/stream", async (c) => {
  return streamSSE(c, async (stream) => {
    let eventIndex = 0;
    let alive = true;

    c.req.raw.signal.addEventListener("abort", () => {
      alive = false;
    });

    while (alive) {
      const scanState = readScanState();
      const lastScannedAt = await getLastScannedAt();

      await stream.writeSSE({
        event: "status",
        data: JSON.stringify({
          phase: scanState.phase,
          running: scanState.running,
          failed: scanState.failed,
          message: scanState.message,
          lastScannedAt,
        }),
      });

      const { events, nextIndex } = readScanEvents(eventIndex);
      for (const event of events) {
        await stream.writeSSE({
          event: "scan",
          data: JSON.stringify(event),
        });
      }
      eventIndex = nextIndex;

      if (!scanState.running && (scanState.phase === "done" || scanState.phase === "idle")) {
        break;
      }

      await stream.sleep(1000);
    }
  });
});
