#!/usr/bin/env node
// Renders public/logo_cropped.png to the PNG sizes the manifest and iOS need.
// Rerun manually after changing the source logo: `node scripts/gen-icons.mjs`.
//
// Uses Playwright's bundled Chromium (already a dev dependency for e2e)
// instead of a raster library. The browser canvas trims transparent padding
// before fitting the source artwork into each square icon.
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iconsDir = join(root, "public", "icons");
mkdirSync(iconsDir, { recursive: true });

const logoDataUrl = `data:image/png;base64,${readFileSync(join(root, "public", "logo_cropped.png")).toString("base64")}`;

function trimLogoHtml() {
  return `<!doctype html><html><body><img id="logo" src="${logoDataUrl}" /></body></html>`;
}

async function trimLogo(page) {
  await page.setContent(trimLogoHtml());
  await page.waitForFunction(() => {
    const image = document.getElementById("logo");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
  return page.evaluate(() => {
    const image = document.getElementById("logo");
    if (!(image instanceof HTMLImageElement)) throw new Error("Logo image did not load");

    const source = document.createElement("canvas");
    source.width = image.naturalWidth;
    source.height = image.naturalHeight;
    const sourceContext = source.getContext("2d");
    if (!sourceContext) throw new Error("Could not create logo canvas");
    sourceContext.drawImage(image, 0, 0);

    const pixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
    let left = source.width;
    let top = source.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        if (pixels[(y * source.width + x) * 4 + 3] > 8) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    }
    if (right < left || bottom < top) throw new Error("Logo has no visible pixels");

    const trimmed = document.createElement("canvas");
    trimmed.width = right - left + 1;
    trimmed.height = bottom - top + 1;
    const trimmedContext = trimmed.getContext("2d");
    if (!trimmedContext) throw new Error("Could not create trimmed logo canvas");
    trimmedContext.drawImage(
      source,
      left,
      top,
      trimmed.width,
      trimmed.height,
      0,
      0,
      trimmed.width,
      trimmed.height,
    );
    return trimmed.toDataURL("image/png");
  });
}

/**
 * @param {number} size output PNG size (square)
 * @param {object} opts
 * @param {number} [opts.scale] logo size as a fraction of the canvas (padding)
 * @param {string} trimmedLogoDataUrl transparent, cropped source artwork
 */
function pageHtml(size, { scale = 1, trimmedLogoDataUrl } = {}) {
  const iconSize = Math.round(size * scale);
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;
      background:transparent;}
    .wrap{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;}
    img{display:block;max-width:${iconSize}px;max-height:${iconSize}px;width:auto;height:auto;}
  </style></head><body><div class="wrap"><img id="logo" src="${trimmedLogoDataUrl}" alt="" /></div></body></html>`;
}

const targets = [
  { file: "icon-192.png", size: 192, opts: { scale: 0.8 } },
  { file: "icon-512.png", size: 512, opts: { scale: 0.8 } },
  { file: "maskable-512.png", size: 512, opts: { scale: 0.8 } },
  { file: "apple-touch-icon.png", size: 180, opts: { scale: 0.8 } },
];

const browser = await chromium.launch();
const trimPage = await browser.newPage();
const trimmedLogoDataUrl = await trimLogo(trimPage);
await trimPage.close();
const page = await browser.newPage();
for (const { file, size, opts } of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(pageHtml(size, { ...opts, trimmedLogoDataUrl }));
  await page.waitForFunction(() => {
    const image = document.getElementById("logo");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
  await page.screenshot({ path: join(iconsDir, file), omitBackground: true });
  console.log(`wrote public/icons/${file}`);
}
await browser.close();
