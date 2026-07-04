import { afterEach, describe, expect, it, vi } from "vitest";

describe("LOCAL_GATE_ENABLED", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to enabled (the free pre-filter runs unless explicitly disabled)", async () => {
    vi.resetModules();
    const { LOCAL_GATE_ENABLED } = await import("../vision.js");
    expect(LOCAL_GATE_ENABLED).toBe(true);
  });

  it("is disabled only when LOCAL_GATE_ENABLED=false", async () => {
    vi.stubEnv("LOCAL_GATE_ENABLED", "false");
    vi.resetModules();
    const { LOCAL_GATE_ENABLED } = await import("../vision.js");
    expect(LOCAL_GATE_ENABLED).toBe(false);
  });

  it("any other value (including unset) keeps the gate enabled", async () => {
    vi.stubEnv("LOCAL_GATE_ENABLED", "true");
    vi.resetModules();
    expect((await import("../vision.js")).LOCAL_GATE_ENABLED).toBe(true);

    vi.stubEnv("LOCAL_GATE_ENABLED", "nonsense");
    vi.resetModules();
    expect((await import("../vision.js")).LOCAL_GATE_ENABLED).toBe(true);
  });
});

describe("LOCAL_GATE_MAX_TOKENS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to 150 — the minimum budget observed to let a reasoning-tuned local model finish its chain-of-thought before answering (at 10, content came back empty on every call, every time)", async () => {
    vi.resetModules();
    const { LOCAL_GATE_MAX_TOKENS } = await import("../vision.js");
    expect(LOCAL_GATE_MAX_TOKENS).toBe(150);
  });

  it("is overridable via env for tuning without a code change", async () => {
    vi.stubEnv("LOCAL_GATE_MAX_TOKENS", "300");
    vi.resetModules();
    const { LOCAL_GATE_MAX_TOKENS } = await import("../vision.js");
    expect(LOCAL_GATE_MAX_TOKENS).toBe(300);
  });
});
