#!/usr/bin/env node
// Renders public/icon.svg to the PNG sizes the manifest and iOS need.
// Rerun manually after the SVG changes: `node scripts/gen-icons.mjs`.
//
// Uses Playwright's bundled Chromium (already a dev dependency for e2e)
// instead of a raster library, so the source SVG (currentColor strokes,
// inline fills) renders exactly as a browser would draw it.
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iconsDir = join(root, "public", "icons");
mkdirSync(iconsDir, { recursive: true });

const svg = readFileSync(join(root, "public", "icon.svg"), "utf8");
const BG = "#0f1115";

/**
 * @param {number} size output PNG size (square)
 * @param {object} opts
 * @param {number} [opts.scale] icon size as a fraction of the canvas (padding)
 * @param {boolean} [opts.opaque] paint a solid background (Apple touch icons
 *   and maskable icons must not be transparent)
 */
function pageHtml(size, { scale = 1, opaque = false } = {}) {
  const iconSize = Math.round(size * scale);
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;
      background:${opaque ? BG : "transparent"};}
    .wrap{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;}
    svg{width:${iconSize}px;height:${iconSize}px;color:#f88901;}
  </style></head><body><div class="wrap">${svg}</div></body></html>`;
}

const targets = [
  { file: "icon-192.png", size: 192, opts: { scale: 0.7, opaque: true } },
  { file: "icon-512.png", size: 512, opts: { scale: 0.7, opaque: true } },
  { file: "maskable-512.png", size: 512, opts: { scale: 0.8, opaque: true } },
  { file: "apple-touch-icon.png", size: 180, opts: { scale: 0.7, opaque: true } },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { file, size, opts } of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(pageHtml(size, opts));
  await page.screenshot({ path: join(iconsDir, file), omitBackground: false });
  console.log(`wrote public/icons/${file}`);
}
await browser.close();
