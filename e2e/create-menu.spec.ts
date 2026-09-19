import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-slot="sidebar-inner"]').getByRole("button", { name: "Add" })).toBeEnabled();
});

test("sidebar add menu offers note and graph", async ({ page }) => {
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  await sidebar.getByRole("button", { name: "Add" }).click();

  await expect(page.getByRole("menuitem", { name: "New note" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "New graph" })).toBeVisible();
});

test("sidebar add menu offers a folder", async ({ page }) => {
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  await sidebar.getByRole("button", { name: "Add" }).click();

  await expect(page.getByRole("menuitem", { name: "New folder" })).toBeVisible();
});

test("top bar capture button opens a note", async ({ page }) => {
  const capture = page.locator("header").getByRole("button", { name: "Capture a thought" });
  await expect(capture).toBeEnabled();
  await capture.click();
  await expect(page.locator(".cm-content")).toBeVisible();
});

test("add controls stay touch-sized on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const capture = page.locator("header").getByRole("button", { name: "Capture a thought" });
  const topBarBox = await capture.boundingBox();
  expect(topBarBox?.width).toBeGreaterThanOrEqual(44);
  expect(topBarBox?.height).toBeGreaterThanOrEqual(44);

  await page.locator('[data-slot="sidebar-trigger"]').click();
  const sidebar = page.locator('[data-sidebar="sidebar"]:visible');
  const sidebarAdd = sidebar.getByRole("button", { name: "Add" });
  const sidebarBox = await sidebarAdd.boundingBox();
  expect(sidebarBox?.width).toBeGreaterThanOrEqual(44);
  expect(sidebarBox?.height).toBeGreaterThanOrEqual(44);
});
