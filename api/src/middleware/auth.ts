import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { DEV_USER_SUB, type AppEnv } from "../types/env.js";

const AUTH_MODE = process.env.AUTH_MODE ?? "stub";

// Lazy-init so JWKS is only fetched when AUTH_MODE=jwt
let JWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!JWKS) {
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) throw new Error("OIDC_ISSUER env var required when AUTH_MODE=jwt");
    JWKS = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/.well-known/jwks.json`));
  }
  return JWKS;
}

async function resolveFromJwt(headers: Headers): Promise<string | null> {
  const auth = headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { payload } = await jwtVerify(token, getJWKS(), {
    issuer: process.env.OIDC_ISSUER,
  });
  return (payload.sub as string) ?? null;
}

async function resolveUserSub(headers: Headers): Promise<string | null> {
  if (AUTH_MODE === "stub") return DEV_USER_SUB;

  if (AUTH_MODE === "forwarded") {
    return (
      headers.get("x-authentik-uid") ??
      headers.get("x-authentik-jwt") ??
      headers.get("x-remote-user") ??
      headers.get("x-forwarded-user") ??
      null
    );
  }

  if (AUTH_MODE === "jwt") {
    return resolveFromJwt(headers).catch(() => null);
  }

  return DEV_USER_SUB;
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const userSub = await resolveUserSub(c.req.raw.headers);

  if (!userSub) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userSub", userSub);
  await next();
});
