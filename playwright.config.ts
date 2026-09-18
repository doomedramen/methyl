import { defineConfig, devices } from "@playwright/test";

/**
 * E2E port, distinct from the dev server (3000) so `npm run test:e2e` can
 * run alongside `pnpm dev` without colliding.
 */
/**
 * E2E port, distinct from the dev server (3000) so `npm run test:e2e` can
 * run alongside `pnpm dev` without colliding.
 */
const PORT = Number(process.env.METHYL_E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * e2e drives a real dev server so Next.js handles dynamic routes, edge
 * functions, and static chunks exactly as in production. Playwright starts
 * it itself via webServer below (reusing an already-running dev server when
 * present). The vault lives entirely in browser OPFS when no sync server is
 * configured (see getVault() in src/lib/browser/vault.ts), so no sync server
 * or reverse proxy is needed for these tests.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Playwright starts the dev server itself (fast enough after the first
    // cold compile; reuseExistingServer reuses one that's already running).
    // We drive real Next.js dev — not a standalone build — because this app
    // ships on dynamic routes (`/graph/[...]` etc.); a static standalone
    // server can't serve those routes' chunks in this environment.
    command: "npm run dev",
    url: BASE_URL,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
