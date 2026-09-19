import { devices, expect, test, type Locator, type Page } from "@playwright/test";

test.use({ ...devices["iPhone 13"], browserName: "chromium" });

async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.locator("header").getByRole("button", { name: "Add" })).toBeEnabled();
}

async function expectTouchTarget(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} should be visible`).not.toBeNull();
  expect(box?.width, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(box?.height, `${label} height`).toBeGreaterThanOrEqual(44);
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth, "mobile layout should not overflow horizontally").toBeLessThanOrEqual(
    metrics.clientWidth,
  );
}

test.describe("mobile quality", () => {
  test("small-phone header controls are touch-sized and fit", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openApp(page);

    await expectTouchTarget(
      page.locator('[data-slot="sidebar-trigger"]'),
      "sidebar trigger",
    );
    await expectTouchTarget(
      page.locator("header").getByRole("button", { name: "Toggle theme" }),
      "theme toggle",
    );
    await expectTouchTarget(page.locator("header").getByRole("button", { name: "Add" }), "add");
    await expectNoHorizontalOverflow(page);
  });

  test("mobile sidebar controls and rows are touch-sized", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openApp(page);

    await page.locator('[data-slot="sidebar-trigger"]').click();
    const sidebar = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
    await expect(sidebar).toBeVisible();

    await expectTouchTarget(sidebar.getByRole("button", { name: "Add" }), "sidebar add");
    await expectTouchTarget(sidebar.getByRole("button", { name: "Search notes" }), "search notes");
    await expect(sidebar.getByRole("button", { name: "New folder" })).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("menuitem", { name: "New folder" })).toBeVisible();

    await expect(sidebar.locator('button[aria-label="Close sidebar"]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("note editing stays within the viewport in portrait and landscape", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openApp(page);

    await page.locator("header").getByRole("button", { name: "Add" }).click();
    await page.getByRole("menuitem", { name: "New note" }).click();
    const editor = page.locator(".cm-content");
    await expect(editor).toBeVisible();
    await editor.fill("A mobile note with enough content to exercise the editor width.");
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(editor).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("reduced motion removes side-sheet transition", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);

    await page.locator('[data-slot="sidebar-trigger"]').click();
    const sidebar = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
    await expect(sidebar).toBeVisible();
    await expect
      .poll(() => sidebar.evaluate((element) => getComputedStyle(element).transitionDuration))
      .toBe("0s");
  });
});
