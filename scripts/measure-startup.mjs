// Measure warm-cache startup (spec item 20): sync a vault from a running
// Methyl server into a fresh browser profile, then time reloads with the
// app's `methyl:*` performance marks under CPU throttling.
//
//   node scripts/measure-startup.mjs <serverUrl> <token> [cpuSlowdown] [expectedNotes]
//
// Point it at a server whose vault holds the notes to test with (e.g. 400
// generated notes). PLAYWRIGHT_CHROMIUM_EXECUTABLE picks a Chromium build.
import { chromium } from "@playwright/test";

const [, , baseUrl, token, slowdownArg, expectedArg] = process.argv;
if (!baseUrl || !token) {
  console.error("usage: node scripts/measure-startup.mjs <serverUrl> <token> [cpuSlowdown] [expectedNotes]");
  process.exit(2);
}
const slowdown = Number(slowdownArg ?? 4);
const expected = Number(expectedArg ?? 400);

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(baseUrl);
await page.evaluate(
  ([url, t]) => localStorage.setItem("adhd-sync-config", JSON.stringify({ serverUrl: url, authToken: t })),
  [baseUrl, token],
);
await page.reload();
// Wait for the initial sync to bring every note in.
const started = Date.now();
for (;;) {
  const files = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let vault;
    try {
      vault = await root.getDirectoryHandle("adhd-vault");
    } catch {
      return 0;
    }
    let n = 0;
    async function walk(dir) {
      for await (const [name, h] of dir.entries()) {
        if (name === ".adhd") continue;
        if (h.kind === "file" && name.endsWith(".md")) n++;
        else if (h.kind === "directory") await walk(h);
      }
    }
    await walk(vault);
    return n;
  });
  if (files >= expected) break;
  if (Date.now() - started > 240_000) throw new Error(`sync stalled at ${files} of ${expected} notes`);
  await page.waitForTimeout(1000);
}
// Let the writer settle (persists, index writes).
await page.waitForTimeout(3000);

const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: slowdown });

const runs = [];
for (let i = 0; i < 3; i++) {
  await page.reload();
  await page.waitForFunction(() => performance.getEntriesByName("methyl:engine-ready").length > 0, null, {
    timeout: 120_000,
  });
  const marks = await page.evaluate(() =>
    performance
      .getEntriesByType("mark")
      .filter((m) => m.name.startsWith("methyl:"))
      .map((m) => [m.name.slice(7), Math.round(m.startTime)]),
  );
  const wasm = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((r) => r.name.endsWith(".wasm"))
      .map((r) => ({ start: Math.round(r.startTime), end: Math.round(r.responseEnd), size: r.encodedBodySize, transfer: r.transferSize })),
  );
  runs.push({ marks: Object.fromEntries(marks), wasm });
  await page.waitForTimeout(2000);
}
console.log(JSON.stringify({ slowdown, runs }, null, 1));
await browser.close();
