import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { hunts } from "../db/schema.js";
import type { AppEnv } from "../types/env.js";
import { getUserSettings, upsertUserSettings } from "../services/sales.js";

export const huntRoutes = new Hono<AppEnv>();

huntRoutes.get("/", async (c) => {
  const ownerSub = c.get("userSub");
  const rows = await db.select().from(hunts).where(eq(hunts.ownerSub, ownerSub));
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

  const [created] = await db
    .insert(hunts)
    .values({
      ownerSub,
      name: body.name.trim(),
      keywords,
      createdAt: new Date().toISOString(),
    })
    .returning();

  return c.json({ hunt: created }, 201);
});

huntRoutes.put("/:id", async (c) => {
  const ownerSub = c.get("userSub");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ name?: string; keywords?: string[] }>();

  const [existing] = await db
    .select()
    .from(hunts)
    .where(eq(hunts.id, id));

  if (!existing || existing.ownerSub !== ownerSub) {
    return c.json({ error: "Hunt not found" }, 404);
  }

  const updates: Partial<typeof hunts.$inferInsert> = {};
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

  const [updated] = await db
    .update(hunts)
    .set(updates)
    .where(eq(hunts.id, id))
    .returning();

  return c.json({ hunt: updated });
});

huntRoutes.delete("/:id", async (c) => {
  const ownerSub = c.get("userSub");
  const id = Number(c.req.param("id"));

  const [existing] = await db
    .select()
    .from(hunts)
    .where(eq(hunts.id, id));

  if (!existing || existing.ownerSub !== ownerSub) {
    return c.json({ error: "Hunt not found" }, 404);
  }

  await db.delete(hunts).where(eq(hunts.id, id));
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
