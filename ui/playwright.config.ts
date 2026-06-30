import { defineConfig, devices } from "@playwright/test";

const PORT = 4321;

// e2e runs the real API (stub auth) serving the stub UI build against a seeded temp
// db. Build first (test:e2e does), then the webServer seeds + serves.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ../scripts/e2e-server.mjs",
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT) },
  },
});
