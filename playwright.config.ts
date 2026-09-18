import { defineConfig, devices } from "@playwright/test";

/**
 * E2E port, distinct from the dev server (3000) so `npm run test:e2e` can
 * run alongside `pnpm dev` without colliding.
 */
const PORT = Number(process.env.METHYL_E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Serves the app the same way it's deployed for real use: `next build`
 * (which produces `.next/standalone`, see next.config.ts's `output:
 * "standalone"`) followed by running that standalone server directly —
 * `next start` refuses to run against a standalone build ("next start"
 * does not work with "output: standalone" configuration). This is the same
 * child process src/server/main.ts spawns internally (see
 * startNextServer() there); this config just runs it directly instead of
 * going through that wrapper's sync-server + reverse-proxy machinery,
 * which these tests never touch — the vault is created and read entirely
 * from browser OPFS when no sync server is configured (see getVault() in
 * src/lib/browser/vault.ts).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
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
    command: `npm run build && node .next/standalone/server.js`,
    url: BASE_URL,
    env: { PORT: String(PORT), HOSTNAME: "127.0.0.1" },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
