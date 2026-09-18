import { defineConfig, devices } from "@playwright/test";

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
    // Build the app, bundle the server, then run it in-process (see
    // src/server/main.ts): it hosts the app, sync API, and healthz on one
    // port exactly as the deployed container does. Playwright starts it
    // itself via webServer below (reusing an already-running one when
    // present). The vault lives entirely in browser OPFS when no sync server
    // is configured (see getVault() in src/lib/browser/vault.ts), so the
    // server's vault path is only a scratch dir.
    command: "npm run build && npm run build:server && node dist/server.cjs",
    url: BASE_URL,
    env: {
      METHYL_PORT: String(PORT),
      METHYL_HOST: "127.0.0.1",
      METHYL_AUTH_TOKEN: "e2e-test-token",
      METHYL_VAULT_PATH: "./.e2e-vault",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
