import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { DEV_USER_SUB, type AppEnv } from "../types/env.js";

const AUTH_MODE = process.env.AUTH_MODE ?? "stub";

// Lazy-init: fetch JWKS URI from discovery document (avoids hardcoding provider-specific paths)
let JWKSPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

function getJWKS(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (!JWKSPromise) {
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) return Promise.reject(new Error("OIDC_ISSUER required when AUTH_MODE=jwt"));

    const discoveryUrl = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    JWKSPromise = fetch(discoveryUrl)
      .then((r) => r.json())
      .then((cfg: { jwks_uri: string }) => createRemoteJWKSet(new URL(cfg.jwks_uri)))
      .catch((e) => {
        JWKSPromise = null; // reset so next request retries
        throw e;
      });
  }
  return JWKSPromise;
}

async function resolveFromJwt(headers: Headers): Promise<string | null> {
  const auth = headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const jwks = await getJWKS();
  const { payload } = await jwtVerify(token, jwks);
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
