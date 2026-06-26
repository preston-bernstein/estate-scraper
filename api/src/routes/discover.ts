import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import { getDiscoverData, searchSales } from "../services/discover.js";

export const discoverRoutes = new Hono<AppEnv>();

discoverRoutes.get("/", async (c) => {
  const data = await getDiscoverData();
  return c.json(data);
});

discoverRoutes.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const results = await searchSales(q);
  return c.json({ sales: results });
});
