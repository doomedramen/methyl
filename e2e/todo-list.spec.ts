import { test, expect } from "@playwright/test";

test("typing a Markdown task marker one key at a time renders a checkbox", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');

  await expect(sidebar.getByRole("button", { name: "Add" })).toBeEnabled();
  await sidebar.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();

  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.focus();
  for (const key of ["-", " ", "[", " ", "]", " ", "i", "t", "e", "m"]) {
    await page.keyboard.type(key);
  }

  const checkbox = page.locator(".cm-lp-checkbox");
  await expect(checkbox).toHaveCount(1);
  await expect(checkbox).not.toBeChecked();
  await expect(editor).toContainText("item");
});
