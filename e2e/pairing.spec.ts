import { test, expect, type Page } from "@playwright/test";

/**
 * Device pairing (spec item 5): the admin token pairs the browser once and
 * is never stored — not in localStorage, IndexedDB or OPFS. The browser is
 * then signed in by an HttpOnly cookie scripts can't read.
 */

const ADMIN_TOKEN = "e2e-test-token"; // METHYL_AUTH_TOKEN in playwright.config.ts

async function openSyncSettings(page: Page) {
  const footer = page.locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: /offline|online|Sync|Synced|Syncing/i }).first().click();
  await page.getByRole("button", { name: /^Sync/ }).filter({ hasText: "Sync" }).first().click();
  await expect(page.getByRole("dialog", { name: "Sync" })).toBeVisible();
}

/** Every place a page script could have put the token. */
async function storedAnywhere(page: Page, secret: string): Promise<string[]> {
  return page.evaluate(async (secret) => {
    const found: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if ((localStorage.getItem(key) ?? "").includes(secret)) found.push(`localStorage:${key}`);
    }
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(info.name!);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(store).objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (JSON.stringify(values).includes(secret)) found.push(`indexedDB:${info.name}/${store}`);
      }
      db.close();
    }
    const walk = async (dir: FileSystemDirectoryHandle, path: string) => {
      for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        const child = `${path}/${name}`;
        if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, child);
        else if ((await (await (handle as FileSystemFileHandle).getFile()).text()).includes(secret)) found.push(`opfs:${child}`);
      }
    };
    await walk(await navigator.storage.getDirectory(), "");
    return found;
  }, secret);
}

test("pairing keeps no token in browser storage, and syncs with the device cookie", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-slot="sidebar-inner"]')).toBeVisible();
  await openSyncSettings(page);

  const dialog = page.getByRole("dialog", { name: "Sync" });
  await dialog.getByLabel("Admin token").fill(ADMIN_TOKEN);
  await dialog.getByRole("button", { name: "Pair and save" }).click();
  await expect(dialog).toBeHidden();

  // The round runs on the cookie and a ticket.
  const footer = page.locator('[data-slot="sidebar-footer"]');
  await expect(footer.getByRole("button", { name: /Synced/ })).toBeVisible({ timeout: 20_000 });

  expect(await storedAnywhere(page, ADMIN_TOKEN)).toEqual([]);
  // HttpOnly: invisible to scripts, present for the browser.
  expect(await page.evaluate(() => document.cookie)).not.toContain("methyl_device");
  const cookies = await page.context().cookies();
  const device = cookies.find((c) => c.name === "methyl_device");
  expect(device?.httpOnly).toBe(true);
  expect(device?.sameSite).toBe("Strict");
});

test("a token saved by an older version is exchanged for pairing and deleted", async ({ page }) => {
  await page.goto("/manifest.webmanifest");
  const origin = new URL(page.url()).origin;
  await page.evaluate(
    ([origin, token]) => localStorage.setItem("methyl.sync-config", JSON.stringify({ serverUrl: origin, authToken: token })),
    [origin, ADMIN_TOKEN],
  );

  await page.goto("/");
  const footer = page.locator('[data-slot="sidebar-footer"]');
  await expect(footer.getByRole("button", { name: /Synced/ })).toBeVisible({ timeout: 20_000 });
  expect(await storedAnywhere(page, ADMIN_TOKEN)).toEqual([]);
  expect((await page.context().cookies()).some((c) => c.name === "methyl_device")).toBe(true);
});
