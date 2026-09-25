import { test, expect, type Page } from "@playwright/test";

/**
 * Multiple vaults (spec item 9): separate notes per vault, switching by the
 * sidebar's vault menu, and migration of the single-vault OPFS layout.
 */

async function createNote(page: Page, text: string) {
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  await sidebar.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await page.waitForTimeout(800);
}

test("a second vault keeps its own notes, and switching back finds the first vault's", async ({ page }) => {
  await page.goto("/");
  await createNote(page, "only in the first vault");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  await expect(sidebar.getByText("Untitled", { exact: true })).toBeVisible();

  await sidebar.getByRole("button", { name: /Switch vault/ }).click();
  await page.getByRole("menuitem", { name: "Manage vaults…" }).click();
  await page.getByRole("textbox", { name: "New vault" }).fill("Work");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByRole("button", { name: "Vault: Work. Switch vault" })).toBeVisible();
  await expect(sidebar.getByText("Untitled", { exact: true })).toHaveCount(0);

  await sidebar.getByRole("button", { name: /Switch vault/ }).click();
  await page.getByRole("menuitem", { name: "My vault" }).click();
  await expect(page.getByRole("button", { name: "Vault: My vault. Switch vault" })).toBeVisible();
  await sidebar.getByText("Untitled", { exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("only in the first vault");
});

test("an archived vault stays out of the active list after refresh", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  await sidebar.getByRole("button", { name: /Switch vault/ }).click();
  await page.getByRole("menuitem", { name: "Manage vaults…" }).click();
  await page.getByRole("textbox", { name: "New vault" }).fill("Archive test");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("button", { name: "Vault: Archive test. Switch vault" })).toBeVisible();

  await sidebar.getByRole("button", { name: /Switch vault/ }).click();
  await page.getByRole("menuitem", { name: "My vault" }).click();
  await sidebar.getByRole("button", { name: /Switch vault/ }).click();
  await page.getByRole("menuitem", { name: "Manage vaults…" }).click();

  const testVault = page.getByRole("list", { name: "Vaults" }).getByRole("listitem").filter({ hasText: "Archive test" });
  await testVault.getByRole("button", { name: "Archive" }).click();
  await page.locator("#archive-vault-confirm").fill("Archive test");
  await page.getByRole("button", { name: "Archive vault" }).click();
  await expect(testVault).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.reload();
  await sidebar.getByRole("button", { name: /Switch vault/ }).click();
  await expect(page.getByRole("menuitem", { name: "Archive test" })).toHaveCount(0);
});

test("a vault from before multi-vault is moved into place and opens with its notes", async ({ page }) => {
  // Same origin, before the app has run: lay out OPFS the way older builds did.
  await page.goto("/manifest.webmanifest");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const old = await root.getDirectoryHandle("adhd-vault", { create: true });
    const file = await old.getFileHandle("Legacy note.md", { create: true });
    const w = await file.createWritable();
    await w.write("written by an older build\n");
    await w.close();
  });

  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  // The startup reconcile runs in the background and adopts the file.
  await expect(sidebar.getByText("Legacy note", { exact: true })).toBeVisible({ timeout: 15_000 });
  const leftovers = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      const old = await root.getDirectoryHandle("adhd-vault");
      let n = 0;
      for await (const entry of (old as unknown as { values(): AsyncIterable<unknown> }).values()) {
        void entry;
        n++;
      }
      return n;
    } catch {
      return 0;
    }
  });
  expect(leftovers).toBe(0);
});
