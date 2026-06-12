import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readScanState } from "../scan/state.js";
import type { AppEnv } from "../types/env.js";
import {
  getLastScannedAt,
  getSaleDetail,
  listPastSales,
  listUpcomingSales,
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

salesRoutes.get("/:id", async (c) => {
  const ownerSub = c.get("userSub");
  const detail = await getSaleDetail(ownerSub, c.req.param("id"));

  if (!detail) {
    return c.json({ error: "Sale not found" }, 404);
  }

  return c.json(detail);
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

export const scanRoutes = new Hono();

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

      while (eventIndex < scanState.events.length) {
        const event = scanState.events[eventIndex]!;
        eventIndex += 1;
        await stream.writeSSE({
          event: "scan",
          data: JSON.stringify(event),
        });
      }

      if (!scanState.running && scanState.phase === "done") {
        break;
      }

      await stream.sleep(1000);
    }
  });
});
