import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import {
  addPlanItem,
  getPlanSaleIds,
  listPlanItems,
  removePlanItem,
  reorderPlanItems,
} from "../services/sales.js";

export const planRoutes = new Hono<AppEnv>();

planRoutes.get("/", async (c) => {
  const ownerSub = c.get("userSub");
  const items = await listPlanItems(ownerSub);
  return c.json({ items });
});

planRoutes.get("/sale-ids", async (c) => {
  const ownerSub = c.get("userSub");
  const saleIds = await getPlanSaleIds(ownerSub);
  return c.json({ saleIds });
});

planRoutes.post("/", async (c) => {
  const ownerSub = c.get("userSub");
  const body = await c.req.json<{ saleId?: string }>();

  if (!body.saleId) {
    return c.json({ error: "saleId is required" }, 400);
  }

  const item = await addPlanItem(ownerSub, body.saleId);
  if (!item) {
    return c.json({ error: "Sale not found" }, 404);
  }

  return c.json({ item }, 201);
});

planRoutes.delete("/:saleId", async (c) => {
  const ownerSub = c.get("userSub");
  await removePlanItem(ownerSub, c.req.param("saleId"));
  return c.json({ ok: true });
});

planRoutes.put("/reorder", async (c) => {
  const ownerSub = c.get("userSub");
  const body = await c.req.json<{ saleIds?: string[] }>();

  if (!body.saleIds || !Array.isArray(body.saleIds)) {
    return c.json({ error: "saleIds array is required" }, 400);
  }

  await reorderPlanItems(ownerSub, body.saleIds);
  return c.json({ ok: true });
});
