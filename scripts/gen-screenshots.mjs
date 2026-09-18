#!/usr/bin/env node
// One-off: captures the manifest's `screenshots` images against a running
// e2e server (see playwright.config.ts). Not wired into `npm run build` —
// rerun manually after a meaningful UI change:
//   METHYL_PORT=3100 METHYL_AUTH_TOKEN=e2e-test-token METHYL_VAULT_PATH=./.e2e-vault node dist/server.cjs &
//   node scripts/gen-screenshots.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "public", "screenshots");
mkdirSync(outDir, { recursive: true });
const BASE_URL = process.env.METHYL_E2E_URL ?? "http://127.0.0.1:3100";

const browser = await chromium.launch();

const wide = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await wide.goto(BASE_URL);
await wide.waitForTimeout(1200);
await wide.screenshot({ path: join(outDir, "wide.png") });
await wide.close();

const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
await narrow.goto(BASE_URL);
await narrow.waitForTimeout(1200);
await narrow.screenshot({ path: join(outDir, "narrow.png") });
await narrow.close();

await browser.close();
console.log("wrote public/screenshots/{wide,narrow}.png");
