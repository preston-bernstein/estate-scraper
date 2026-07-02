import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../types/env.js";

// auth.ts validates AUTH_MODE (and mode-specific required env vars) at module load,
// so each scenario needs a fresh module instance with its own env — vi.resetModules
// plus a dynamic import per test, rather than one static top-level import.
const ENV_KEYS = [
  "AUTH_MODE",
  "NODE_ENV",
  "OIDC_ISSUER",
  "OIDC_AUDIENCE",
  "PROXY_SHARED_SECRET",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function loadAuthMiddleware() {
  const mod = await import("../auth.js");
  return mod.authMiddleware;
}

function buildApp(authMiddleware: Awaited<ReturnType<typeof loadAuthMiddleware>>) {
  const app = new Hono<AppEnv>();
  app.use("*", authMiddleware);
  app.get("/", (c) => c.json({ userSub: c.get("userSub") }));
  return app;
}

describe("resolveAuthMode validation (startup)", () => {
  it("rejects an unrecognized AUTH_MODE", async () => {
    process.env.AUTH_MODE = "JWT"; // wrong case — must not silently coerce
    await expect(loadAuthMiddleware()).rejects.toThrow(/AUTH_MODE/);
  });

  it("rejects AUTH_MODE=stub when NODE_ENV=production", async () => {
    process.env.AUTH_MODE = "stub";
    process.env.NODE_ENV = "production";
    await expect(loadAuthMiddleware()).rejects.toThrow(/stub/i);
  });

  it("rejects AUTH_MODE=jwt without OIDC_ISSUER", async () => {
    process.env.AUTH_MODE = "jwt";
    process.env.OIDC_AUDIENCE = "estate-scraper";
    await expect(loadAuthMiddleware()).rejects.toThrow(/OIDC_ISSUER/);
  });

  it("rejects AUTH_MODE=jwt without OIDC_AUDIENCE", async () => {
    process.env.AUTH_MODE = "jwt";
    process.env.OIDC_ISSUER = "https://auth.example.com/application/o/estate-scraper/";
    await expect(loadAuthMiddleware()).rejects.toThrow(/OIDC_AUDIENCE/);
  });

  it("rejects AUTH_MODE=forwarded without PROXY_SHARED_SECRET", async () => {
    process.env.AUTH_MODE = "forwarded";
    await expect(loadAuthMiddleware()).rejects.toThrow(/PROXY_SHARED_SECRET/);
  });
});

describe("stub mode", () => {
  it("authenticates every request as the dev user", async () => {
    process.env.AUTH_MODE = "stub";
    const app = buildApp(await loadAuthMiddleware());
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userSub: "dev-user" });
  });
});

describe("forwarded mode", () => {
  beforeEach(() => {
    process.env.AUTH_MODE = "forwarded";
    process.env.PROXY_SHARED_SECRET = "correct-secret";
  });

  it("rejects a request with no proxy secret header", async () => {
    const app = buildApp(await loadAuthMiddleware());
    const res = await app.request("/", { headers: { "x-authentik-uid": "someone" } });
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong proxy secret — headers are spoofable without this", async () => {
    const app = buildApp(await loadAuthMiddleware());
    const res = await app.request("/", {
      headers: { "x-authentik-uid": "someone", "x-proxy-secret": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("trusts the identity header once the correct proxy secret is presented", async () => {
    const app = buildApp(await loadAuthMiddleware());
    const res = await app.request("/", {
      headers: { "x-authentik-uid": "owner-sub", "x-proxy-secret": "correct-secret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userSub: "owner-sub" });
  });

  it("falls back through the header precedence order", async () => {
    const app = buildApp(await loadAuthMiddleware());
    const res = await app.request("/", {
      headers: { "x-remote-user": "fallback-sub", "x-proxy-secret": "correct-secret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userSub: "fallback-sub" });
  });
});

describe("jwt mode", () => {
  beforeEach(() => {
    process.env.AUTH_MODE = "jwt";
    process.env.OIDC_ISSUER = "https://auth.example.com/application/o/estate-scraper/";
    process.env.OIDC_AUDIENCE = "estate-scraper";
  });

  it("rejects a request with no Authorization header", async () => {
    const app = buildApp(await loadAuthMiddleware());
    const res = await app.request("/");
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Bearer token without leaking the verification error", async () => {
    const app = buildApp(await loadAuthMiddleware());
    const res = await app.request("/", { headers: { authorization: "Bearer not-a-real-jwt" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });
});
