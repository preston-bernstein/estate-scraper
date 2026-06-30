import { test, expect } from "@playwright/test";

// Runs against the seeded e2e db (scripts/e2e-server.mjs): an upcoming sale with
// findings, a past sale, and NO hunts for the stub user.

test("Discover landing renders ranked upcoming sales (not Hunt-gated)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("E2E Upcoming Estate")).toBeVisible();
});

test("Browse is reachable from the nav", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Browse" }).first()).toBeVisible();
});

test("Browse → Upcoming shows all sales + a no-Hunts nudge when no Hunts exist", async ({ page }) => {
  await page.goto("/browse");
  await expect(page.getByText(/create a Hunt/i)).toBeVisible();
  await expect(page.getByText("E2E Upcoming Estate")).toBeVisible();
});

test("Browse → All sales includes past sales", async ({ page }) => {
  await page.goto("/browse");
  await page.getByRole("button", { name: "All sales" }).click();
  await expect(page.getByText("E2E Past Estate")).toBeVisible();
});

test("Browse → All items shows the flagged-item grid", async ({ page }) => {
  await page.goto("/browse");
  await page.getByRole("button", { name: "All items" }).click();
  await expect(page.getByText("Stickley oak armchair")).toBeVisible();
});
