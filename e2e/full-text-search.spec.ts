import { test, expect } from "@playwright/test";

test("command palette finds a note by body text", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');

  await sidebar.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();

  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.fill("A body-only search phrase: phosphorescent meadow.");
  await page.waitForTimeout(800);

  await sidebar.getByRole("button", { name: "Search notes" }).click();
  const search = page.locator('[data-slot="command-input"]');
  await expect(search).toBeVisible();
  await search.fill("phosphorescent meadow");

  const result = page.getByRole("option", { name: /Untitled/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(editor).toContainText("phosphorescent meadow");
});
