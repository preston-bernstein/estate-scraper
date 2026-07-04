import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import { getDiscoverData } from "../services/discover.js";
import { searchSalesHybrid } from "../services/semanticSearch.js";

export const discoverRoutes = new Hono<AppEnv>();

discoverRoutes.get("/", async (c) => {
  const data = await getDiscoverData();
  return c.json(data);
});

// Phase 2 (semantic-search): searchSalesHybrid always computes the Phase 1
// lexical result first and only adds semantic ranking on top when
// SEMANTIC_SEARCH_ENABLED=true and the embedding endpoint is configured. Since
// that flag defaults off, this is behaviorally identical to calling searchSales
// directly until an operator opts in — rollback is flipping the env var, no
// redeploy (docs/semantic-search/steps.md).
discoverRoutes.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const results = await searchSalesHybrid(q);
  return c.json({ sales: results });
});
