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
