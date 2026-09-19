import { test, expect } from "@playwright/test";

test("backlinks panel lists notes linking to the current note", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');

  await sidebar.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.fill("# Target\n\nThe destination note.");
  await page.waitForTimeout(800);

  await sidebar.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();
  await expect(editor).toBeVisible();
  await editor.fill("See [[Untitled]] for details.");
  await page.waitForTimeout(800);

  await sidebar.getByRole("button", { name: "Untitled", exact: true }).click();
  const backlinksButton = page.getByRole("button", { name: "Show backlinks" });
  await expect(backlinksButton).toBeEnabled();
  await backlinksButton.click();

  await expect(page.getByRole("heading", { name: "Backlinks" })).toBeVisible();
  const sourceButton = page.getByRole("button", { name: "Untitled 2", exact: true });
  await expect(sourceButton).toBeVisible();

  await page.getByRole("button", { name: "Close" }).click();
  await expect(backlinksButton).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const backlinksBox = await backlinksButton.boundingBox();
  expect(backlinksBox?.width).toBeGreaterThanOrEqual(44);
  expect(backlinksBox?.height).toBeGreaterThanOrEqual(44);

  await backlinksButton.click();
  await expect(sourceButton).toBeVisible();
  const sourceBox = await sourceButton.boundingBox();
  expect(sourceBox?.height).toBeGreaterThanOrEqual(44);
  await sourceButton.click();
  await expect(editor).toContainText("See Untitled for details.");
});
