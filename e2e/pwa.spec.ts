import { test, expect } from "@playwright/test";

/**
 * PWA surface coverage (SPEC: installable-everywhere, capture entry
 * points):
 *  - manifest.webmanifest parses and carries the fields installability and
 *    the OS capture paths (shortcuts, share_target, file_handlers) depend
 *    on.
 *  - `?action=new` (used by the manifest's "New note" shortcut) creates and
 *    opens a note, and strips the query param once handled.
 */

test("manifest.webmanifest is valid and carries the capture-path fields", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const manifest = await res.json();

  expect(manifest.name).toBe("Methyl");
  expect(manifest.display).toBe("standalone");
  expect(Array.isArray(manifest.icons)).toBe(true);
  expect(manifest.icons.length).toBeGreaterThan(0);
  // Every declared icon must actually resolve (a 404 here breaks
  // installability in most browsers' manifest validators).
  for (const icon of manifest.icons) {
    const iconRes = await request.get(icon.src);
    expect(iconRes.ok(), `icon ${icon.src} should be reachable`).toBe(true);
  }

  expect(manifest.shortcuts?.some((s: { url: string }) => s.url === "/?action=new")).toBe(true);
  expect(manifest.share_target?.action).toBe("/share");
  expect(manifest.file_handlers?.[0]?.action).toBe("/?action=open-file");
});

test("?action=new creates and opens a note, then strips the query param", async ({ page }) => {
  await page.goto("/?action=new");
  await page.waitForTimeout(1200);

  await expect(page.getByRole("navigation", { name: "breadcrumb" })).toContainText("Untitled");
  // Once VaultApp has handled the action it rewrites the URL without it —
  // the note itself continues to mirror into the path instead (see
  // VaultApp.tsx's URL-mirroring effect).
  await expect(page).not.toHaveURL(/action=new/);
});
