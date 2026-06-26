import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import { getDiscoverData } from "../services/discover.js";

export const discoverRoutes = new Hono<AppEnv>();

discoverRoutes.get("/", async (c) => {
  const data = await getDiscoverData();
  return c.json(data);
});
