import { test, expect } from "@playwright/test";

test("defines a template and creates a note from it", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');

  await sidebar.getByRole("button", { name: "Search notes" }).click();
  const commandSearch = page.locator('[data-slot="command-input"]');
  await commandSearch.fill("Templates: Manage");
  await page.getByRole("option", { name: "Templates: Manage" }).click();

  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  await page.getByRole("button", { name: "New template" }).click();
  await page.getByLabel("Name").fill("Daily note");
  await page.getByLabel("Markdown").fill("# Daily note\n\n- Focus\n");
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText("Daily note", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Close" }).last().click();
  await sidebar.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "From template" }).click();
  await expect(page.getByRole("heading", { name: "New note from template" })).toBeVisible();
  await page.getByRole("option", { name: "Daily note" }).click();
  await page.getByRole("button", { name: "Create note" }).click();

  await expect(page.locator(".cm-content")).toContainText("# Daily note");
});
