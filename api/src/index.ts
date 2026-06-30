import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db, runMigrations } from "./db/index.js";
import { authMiddleware } from "./middleware/auth.js";
import { huntRoutes, settingsRoutes } from "./routes/hunts.js";
import { planRoutes } from "./routes/plan.js";
import { findingsRoutes, salesRoutes, scanRoutes, statusRoutes, thumbsRoutes } from "./routes/sales.js";
import { discoverRoutes } from "./routes/discover.js";
import { chatRoutes } from "./routes/chat.js";
import { DEV_USER_SUB, type AppEnv } from "./types/env.js";

runMigrations();

const app = new Hono<AppEnv>();

app.use("*", cors());
app.use("/api/*", authMiddleware);

// Public thumbnail serving (no auth — see thumbsRoutes). Mounted before the static
// catch-all so /thumbs/:id resolves to the file, not index.html.
app.route("/thumbs", thumbsRoutes);

app.get("/api/health", (c) => c.json({ ok: true }));
const SCAN_OWNER_SUB = process.env.SCAN_OWNER_SUB ?? "";
app.get("/api/me", (c) => {
  const sub = c.get("userSub");
  return c.json({ sub, canTriggerScan: Boolean(SCAN_OWNER_SUB && sub === SCAN_OWNER_SUB) });
});
app.route("/api/sales", salesRoutes);
app.route("/api/hunts", huntRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/plan", planRoutes);
app.route("/api/status", statusRoutes);
app.route("/api/scan", scanRoutes);
app.route("/api/findings", findingsRoutes);
app.route("/api/discover", discoverRoutes);
app.route("/api/chat", chatRoutes);

const apiRoot = dirname(fileURLToPath(import.meta.url));
const uiDist = resolve(apiRoot, "../../ui/dist");
const isProduction = process.env.NODE_ENV === "production";

if (isProduction) {
  app.use("/assets/*", serveStatic({ root: uiDist }));
  app.use("*", serveStatic({ root: uiDist }));
  app.get("*", serveStatic({ root: uiDist, path: "index.html" }));
}

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  if (isProduction) {
    console.log(`Serving UI from ${uiDist}`);
  } else if (process.env.AUTH_MODE !== "forwarded") {
    console.log(`Auth stub active (sub: ${DEV_USER_SUB})`);
  }
});

export { app, db };
