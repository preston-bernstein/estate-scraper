import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { DEV_USER_SUB, type AppEnv } from "../types/env.js";

const VALID_MODES = ["stub", "forwarded", "jwt"] as const;
type AuthMode = (typeof VALID_MODES)[number];

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Fail fast on a bad/missing config rather than silently falling back to a dev
// identity: a typo (AUTH_MODE=JWT) or a missing EnvironmentFile must never turn
// production into open access. See docs/adr/0006 (stub is local-dev only).
function resolveAuthMode(): AuthMode {
  const raw = process.env.AUTH_MODE ?? "stub";
  if (!(VALID_MODES as readonly string[]).includes(raw)) {
    throw new Error(`AUTH_MODE="${raw}" must be one of ${VALID_MODES.join(" | ")}`);
  }
  const mode = raw as AuthMode;
  // Narrow, explicit escape hatch for the e2e test harness (scripts/e2e-server.mjs),
  // which deliberately boots a production build with stub auth so Playwright can run
  // against a no-OIDC fixture. Nobody sets this by accident the way they'd leave
  // AUTH_MODE unset — it has to be typed on purpose, which is the point.
  const stubAllowedInProduction = process.env.ALLOW_STUB_IN_PRODUCTION === "true";
  if (IS_PRODUCTION && mode === "stub" && !stubAllowedInProduction) {
    throw new Error("AUTH_MODE=stub is not allowed when NODE_ENV=production");
  }
  if (mode === "jwt") {
    if (!process.env.OIDC_ISSUER) throw new Error("OIDC_ISSUER required when AUTH_MODE=jwt");
    if (!process.env.OIDC_AUDIENCE) throw new Error("OIDC_AUDIENCE required when AUTH_MODE=jwt");
  }
  if (mode === "forwarded" && !process.env.PROXY_SHARED_SECRET) {
    throw new Error("PROXY_SHARED_SECRET required when AUTH_MODE=forwarded");
  }
  return mode;
}

const AUTH_MODE = resolveAuthMode();

// Comma-separated allowlist; the token's `alg` header is never trusted to pick this.
const JWT_ALGORITHMS = (process.env.OIDC_ALGORITHMS ?? "RS256")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

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
  // Pin issuer, audience, and algorithms. Without these, any token signed by a key
  // in the shared IdP JWKS (Authentik reuses one signing cert across providers)
  // would verify here and impersonate its sub — the cross-service token mix-up class
  // of CVE-2025-62610, plus algorithm confusion.
  const { payload } = await jwtVerify(token, jwks, {
    issuer: process.env.OIDC_ISSUER,
    audience: process.env.OIDC_AUDIENCE,
    algorithms: JWT_ALGORITHMS,
  });
  return (payload.sub as string) ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function resolveFromForwarded(headers: Headers): string | null {
  // Only trust proxy-set identity headers when the request also carries the shared
  // secret only the reverse proxy knows. The app is reachable directly on the LAN
  // (:3000), so without this check anyone could `curl -H 'x-authentik-uid: <owner>'`
  // and impersonate any user. Bind to loopback in production for defence in depth.
  const secret = process.env.PROXY_SHARED_SECRET ?? "";
  const presented = headers.get("x-proxy-secret");
  if (!presented || !safeEqual(presented, secret)) return null;
  return (
    headers.get("x-authentik-uid") ??
    headers.get("x-remote-user") ??
    headers.get("x-forwarded-user") ??
    null
  );
}

async function resolveUserSub(headers: Headers): Promise<string | null> {
  switch (AUTH_MODE) {
    case "stub":
      return DEV_USER_SUB;
    case "forwarded":
      return resolveFromForwarded(headers);
    case "jwt":
      return resolveFromJwt(headers).catch(() => null);
    default:
      // Unreachable — AUTH_MODE is validated at startup — but deny rather than allow.
      return null;
  }
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const userSub = await resolveUserSub(c.req.raw.headers);

  if (!userSub) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userSub", userSub);
  await next();
});
