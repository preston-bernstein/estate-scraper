import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import { parsePositiveIntParam } from "../lib/params.js";
import { getUserSettings, upsertUserSettings } from "../services/sales.js";
import { createHunt, deleteHunt, getOwnedHunt, listHunts, updateHunt } from "../services/hunts.js";

export const huntRoutes = new Hono<AppEnv>();

huntRoutes.get("/", async (c) => {
  const ownerSub = c.get("userSub");
  const rows = await listHunts(ownerSub);
  return c.json({ hunts: rows });
});

huntRoutes.post("/", async (c) => {
  const ownerSub = c.get("userSub");
  const body = await c.req.json<{ name?: string; keywords?: string[] }>();

  if (!body.name?.trim()) {
    return c.json({ error: "name is required" }, 400);
  }

  if (!body.keywords || body.keywords.length === 0) {
    return c.json({ error: "keywords array is required" }, 400);
  }

  const keywords = body.keywords.map((keyword) => keyword.trim()).filter(Boolean);
  if (keywords.length === 0) {
    return c.json({ error: "keywords array is required" }, 400);
  }

  const created = await createHunt(ownerSub, body.name.trim(), keywords);
  return c.json({ hunt: created }, 201);
});

huntRoutes.put("/:id", async (c) => {
  const ownerSub = c.get("userSub");
  const id = parsePositiveIntParam(c.req.param("id"));
  if (id === null) return c.json({ error: "Hunt not found" }, 404);
  const body = await c.req.json<{ name?: string; keywords?: string[] }>();

  const existing = await getOwnedHunt(id, ownerSub);
  if (!existing) {
    return c.json({ error: "Hunt not found" }, 404);
  }

  const updates: Partial<typeof existing> = {};
  if (body.name?.trim()) {
    updates.name = body.name.trim();
  }
  if (body.keywords) {
    const keywords = body.keywords.map((keyword) => keyword.trim()).filter(Boolean);
    if (keywords.length === 0) {
      return c.json({ error: "keywords array is required" }, 400);
    }
    updates.keywords = keywords;
  }

  const updated = await updateHunt(id, updates);
  return c.json({ hunt: updated });
});

huntRoutes.delete("/:id", async (c) => {
  const ownerSub = c.get("userSub");
  const id = parsePositiveIntParam(c.req.param("id"));
  if (id === null) return c.json({ error: "Hunt not found" }, 404);

  const existing = await getOwnedHunt(id, ownerSub);
  if (!existing) {
    return c.json({ error: "Hunt not found" }, 404);
  }

  await deleteHunt(id);
  return c.json({ ok: true });
});

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/", async (c) => {
  const ownerSub = c.get("userSub");
  const settings = await getUserSettings(ownerSub);
  return c.json(settings);
});

settingsRoutes.put("/", async (c) => {
  const ownerSub = c.get("userSub");
  const body = await c.req.json<{ radiusMiles?: number }>();

  if (typeof body.radiusMiles !== "number" || body.radiusMiles <= 0) {
    return c.json({ error: "radiusMiles must be a positive number" }, 400);
  }

  const settings = await upsertUserSettings(ownerSub, body.radiusMiles);
  return c.json(settings);
});
