import { test, expect, type Page } from "@playwright/test";

/**
 * Keyboard only (spec item 17): create a note, rename it, move it into a
 * folder, open a split, and switch vaults without a pointer. Controls are
 * reached with focus() standing in for Tab, then driven by keys alone.
 */

async function runCommand(page: Page, name: string) {
  // A dialog that is still closing returns focus as it goes, which would
  // close the command menu again.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const input = page.locator('[data-slot="command-input"]');
  // The Cmd/Ctrl+K listener can lag the first paint: retry until it opens.
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press("ControlOrMeta+k");
    await expect(input).toBeVisible({ timeout: 2000 });
  }).toPass();
  await input.fill(name);
  await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
  // The first option may be a note; move to the command itself.
  for (let i = 0; i < 20; i++) {
    const selected = await page.locator('[data-slot="command-item"][data-selected="true"]').textContent();
    if (selected?.trim() === name) break;
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Enter");
}

/** Open a menu from its trigger with the keyboard and choose an item. */
async function chooseFromMenu(page: Page, trigger: ReturnType<Page["getByRole"]>, item: string) {
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menuItem = page.getByRole("menuitem", { name: item });
  await expect(menuItem).toBeVisible();
  // Wait for the menu to focus its first item before moving through it.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("role")))
    .toBe("menuitem");
  for (let i = 0; i < 20 && !(await menuItem.evaluate((el) => el === document.activeElement)); i++) {
    const before = await page.evaluate(() => document.activeElement?.textContent);
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).not.toBe(before);
  }
  await expect(menuItem).toBeFocused();
  await page.keyboard.press("Enter");
}

test("create, rename, move, split and switch vaults by keyboard", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  await expect(sidebar.getByText("welcome", { exact: true })).toBeVisible();

  // A folder to move into.
  await runCommand(page, "New folder");
  await page.getByRole("textbox", { name: /name/i }).fill("Archive");
  await page.keyboard.press("Enter");
  await expect(sidebar.getByText("Archive", { exact: true })).toBeVisible();

  // Create a note and type into it.
  await runCommand(page, "New note");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("Written without a mouse");
  await expect(sidebar.getByText("Untitled", { exact: true })).toBeVisible();

  // Rename it from the row's actions menu.
  await chooseFromMenu(page, sidebar.getByRole("button", { name: "Actions for Untitled" }), "Rename");
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Keyboard note");
  await page.keyboard.press("Enter");
  await expect(sidebar.getByText("Keyboard note", { exact: true })).toBeVisible();

  // Move it into the folder with "Move to…".
  await sidebar.getByRole("button", { name: "Keyboard note", exact: true }).focus();
  await page.keyboard.press("Enter");
  await runCommand(page, "Note: Move to…");
  await page.keyboard.type("Archive");
  await page.keyboard.press("Enter");
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname)).toBe("/local/Archive/Keyboard note.md");

  // Open a split beside it.
  await chooseFromMenu(page, page.getByRole("button", { name: "Pane options" }).first(), "Split right");
  await expect(page.locator("[data-workspace-pane]")).toHaveCount(2);

  // Create a second vault and switch to it.
  await runCommand(page, "Vaults: Switch or manage");
  const newVault = page.getByRole("textbox", { name: "New vault" });
  await expect(newVault).toBeVisible();
  await newVault.focus();
  await page.keyboard.type("Second");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Vault: Second. Switch vault" })).toBeVisible({ timeout: 15_000 });
});

test("closing a dialog or menu returns focus to what opened it", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  await expect(sidebar.getByText("welcome", { exact: true })).toBeVisible();

  // The command menu, opened from the sidebar's search button.
  const search = sidebar.getByRole("button", { name: "Search notes" });
  await search.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-slot="command-input"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();

  // A note's actions menu, and the rename dialog opened from it.
  const actions = sidebar.getByRole("button", { name: "Actions for welcome" });
  await chooseFromMenu(page, actions, "Rename");
  await expect(page.getByRole("textbox", { name: "Title" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(actions).toBeFocused();

  // Sync settings, from the status popover in the footer.
  const status = page.locator('[data-slot="sidebar-footer"]').getByRole("button").first();
  await status.focus();
  await page.keyboard.press("Enter");
  const syncRow = page.getByRole("button", { name: /^Sync/ }).first();
  await syncRow.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Sync" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Sync" })).toHaveCount(0);
  await expect(page.locator("body")).not.toBeFocused();
});
