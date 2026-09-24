import { test, expect, type Page } from "@playwright/test";

/**
 * Vault safety surfaces (spec items 1 and 2):
 *  - A second tab opens read-only and cannot write to the vault, even
 *    though it opens the same OPFS store (the writer-lock gate in
 *    src/lib/vault/gated-fs.ts); "Use here" hands it the lock.
 *  - Export downloads a ZIP of the vault.
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

async function runCommand(page: Page, name: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator('[data-slot="command-input"]');
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.getByRole("option", { name }).click();
}

test("a second tab is read-only, sees the vault, and can take over", async ({ context }) => {
  const writer = await context.newPage();
  await writer.goto("/");
  await createNote(writer, "written by the first tab");

  const reader = await context.newPage();
  await reader.goto("/");
  await expect(reader.getByText("This tab is read-only.")).toBeVisible();
  await expect(reader.getByText("Untitled", { exact: true }).first()).toBeVisible();

  // The writer keeps working while a read-only tab is open.
  await writer.locator(".cm-content").fill("edited while another tab is open");
  await writer.waitForTimeout(800);
  await expect(writer.getByText("This tab is read-only.")).toHaveCount(0);

  await reader.getByRole("button", { name: "Use here" }).click();
  await expect(reader.getByText("This tab is read-only.")).toHaveCount(0);
});

test("export downloads a ZIP of the vault", async ({ page }) => {
  await page.goto("/");
  await createNote(page, "exported note");

  const download = page.waitForEvent("download");
  await runCommand(page, "Export vault (Markdown and attachments)");
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^methyl-vault-\d{4}-\d{2}-\d{2}\.zip$/);
  const path = await file.path();
  expect(path).toBeTruthy();
});
