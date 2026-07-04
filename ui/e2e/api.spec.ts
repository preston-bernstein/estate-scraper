import { test, expect } from "@playwright/test";

// Exercises the real API end-to-end (HTTP → stub auth → route → service → drizzle →
// sqlite) against the seeded e2e db (scripts/e2e-server.mjs). Every test cleans up
// the rows it creates so the shared, un-reset fixture db stays in its seeded shape
// for app.spec.ts (which asserts "no Hunts exist").

test.describe("health & identity", () => {
  test("GET /api/health is ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /api/me resolves the stub identity", async ({ request }) => {
    const res = await request.get("/api/me");
    expect(res.ok()).toBeTruthy();
    const me = await res.json();
    expect(typeof me.sub).toBe("string");
    expect(me.sub.length).toBeGreaterThan(0);
    expect(typeof me.canTriggerScan).toBe("boolean");
  });

  test("GET /api/status reports scan state", async ({ request }) => {
    const res = await request.get("/api/status");
    expect(res.ok()).toBeTruthy();
    const status = await res.json();
    expect(status).toHaveProperty("lastScannedAt");
    expect(status).toHaveProperty("scanFailed");
  });
});

test.describe("hunts CRUD", () => {
  test("create → list → update → delete a hunt", async ({ request }) => {
    // Create
    const created = await request.post("/api/hunts", {
      data: { name: "E2E Hunt", keywords: ["stickley", "tiffany"] },
    });
    expect(created.status()).toBe(201);
    const { hunt } = await created.json();
    expect(hunt).toMatchObject({ name: "E2E Hunt" });
    expect(hunt.keywords).toEqual(["stickley", "tiffany"]);

    try {
      // List includes it
      const list = await request.get("/api/hunts");
      const { hunts } = await list.json();
      expect(hunts.some((h: { id: number }) => h.id === hunt.id)).toBe(true);

      // Update renames + retrims keywords
      const updated = await request.put(`/api/hunts/${hunt.id}`, {
        data: { name: "E2E Hunt Renamed", keywords: ["  walnut  ", ""] },
      });
      expect(updated.ok()).toBeTruthy();
      const body = await updated.json();
      expect(body.hunt.name).toBe("E2E Hunt Renamed");
      expect(body.hunt.keywords).toEqual(["walnut"]); // trimmed + empties dropped
    } finally {
      // Clean up so app.spec's "no Hunts" assumption holds.
      const del = await request.delete(`/api/hunts/${hunt.id}`);
      expect(del.ok()).toBeTruthy();
    }

    // Gone
    const list = await request.get("/api/hunts");
    const { hunts } = await list.json();
    expect(hunts.some((h: { id: number }) => h.id === hunt.id)).toBe(false);
  });

  test("rejects a hunt with no name or no keywords", async ({ request }) => {
    expect((await request.post("/api/hunts", { data: { keywords: ["x"] } })).status()).toBe(400);
    expect((await request.post("/api/hunts", { data: { name: "x" } })).status()).toBe(400);
    expect(
      (await request.post("/api/hunts", { data: { name: "x", keywords: ["  ", ""] } })).status(),
    ).toBe(400);
  });

  test("update/delete of an unknown hunt is 404", async ({ request }) => {
    expect((await request.put("/api/hunts/999999", { data: { name: "x" } })).status()).toBe(404);
    expect((await request.delete("/api/hunts/999999")).status()).toBe(404);
  });
});

test.describe("plan building", () => {
  test("add → list → reorder → remove seeded sales", async ({ request }) => {
    // Add the two seeded sales.
    const a = await request.post("/api/plan", { data: { saleId: "E2E-UP" } });
    expect(a.status()).toBe(201);
    const b = await request.post("/api/plan", { data: { saleId: "E2E-PAST" } });
    expect(b.status()).toBe(201);

    try {
      const ids = await (await request.get("/api/plan/sale-ids")).json();
      expect(ids.saleIds).toEqual(expect.arrayContaining(["E2E-UP", "E2E-PAST"]));

      const list = await (await request.get("/api/plan")).json();
      expect(list.items.length).toBeGreaterThanOrEqual(2);

      const reorder = await request.put("/api/plan/reorder", {
        data: { saleIds: ["E2E-PAST", "E2E-UP"] },
      });
      expect(reorder.ok()).toBeTruthy();
    } finally {
      await request.delete("/api/plan/E2E-UP");
      await request.delete("/api/plan/E2E-PAST");
    }

    const after = await (await request.get("/api/plan/sale-ids")).json();
    expect(after.saleIds).not.toContain("E2E-UP");
  });

  test("adding an unknown sale is 404 and a missing saleId is 400", async ({ request }) => {
    expect((await request.post("/api/plan", { data: { saleId: "NOPE" } })).status()).toBe(404);
    expect((await request.post("/api/plan", { data: {} })).status()).toBe(400);
    expect((await request.put("/api/plan/reorder", { data: {} })).status()).toBe(400);
  });
});

test.describe("settings", () => {
  test("get, update radius, and reject an invalid radius", async ({ request }) => {
    const before = await (await request.get("/api/settings")).json();
    const original = before.radiusMiles;

    try {
      const put = await request.put("/api/settings", { data: { radiusMiles: 25 } });
      expect(put.ok()).toBeTruthy();
      expect((await put.json()).radiusMiles).toBe(25);

      const after = await (await request.get("/api/settings")).json();
      expect(after.radiusMiles).toBe(25);

      expect((await request.put("/api/settings", { data: { radiusMiles: 0 } })).status()).toBe(400);
      expect(
        (await request.put("/api/settings", { data: { radiusMiles: "far" } })).status(),
      ).toBe(400);
    } finally {
      if (typeof original === "number") {
        await request.put("/api/settings", { data: { radiusMiles: original } });
      }
    }
  });
});

test.describe("sales & findings", () => {
  test("GET /api/sales/:id returns the seeded upcoming sale", async ({ request }) => {
    const res = await request.get("/api/sales/E2E-UP");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const title = JSON.stringify(body);
    expect(title).toContain("E2E Upcoming Estate");
  });

  test("GET /api/findings/all includes a seeded flagged item", async ({ request }) => {
    const res = await request.get("/api/findings/all");
    expect(res.ok()).toBeTruthy();
    expect(JSON.stringify(await res.json())).toContain("Stickley oak armchair");
  });
});
