import { createMiddleware } from "hono/factory";
import { DEV_USER_SUB, type AppEnv } from "../types/env.js";

const AUTH_MODE = process.env.AUTH_MODE ?? "stub";

function resolveUserSub(headers: Headers): string | null {
  if (AUTH_MODE === "stub") {
    return DEV_USER_SUB;
  }

  if (AUTH_MODE === "forwarded") {
    return (
      headers.get("x-authentik-uid") ??
      headers.get("x-authentik-jwt") ??
      headers.get("x-remote-user") ??
      headers.get("x-forwarded-user") ??
      null
    );
  }

  return DEV_USER_SUB;
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const userSub = resolveUserSub(c.req.raw.headers);

  if (!userSub) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userSub", userSub);
  await next();
});
