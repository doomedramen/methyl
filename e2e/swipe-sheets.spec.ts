import { test, expect, type Page } from "@playwright/test";

async function swipe(
  page: Page,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  await page.evaluate(({ startX, startY, endX, endY }) => {
    const event = (type: string, clientX: number, clientY: number) =>
      window.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX,
          clientY,
          isPrimary: true,
          pointerId: 1,
          pointerType: "touch",
        }),
      );

    event("pointerdown", startX, startY);
    event("pointermove", endX, endY);
    event("pointerup", endX, endY);
  }, { startX, startY, endX, endY });
}

test("swiping inward from the left edge opens the mobile sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const sidebar = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
  await expect(page.locator('[data-slot="sidebar-trigger"]')).toBeVisible();
  await expect(sidebar).not.toBeVisible();

  await swipe(page, 8, 420, 72, 428);

  await expect(sidebar).toBeVisible();
});

test("swiping left on the mobile sidebar closes it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator('[data-slot="sidebar-trigger"]').click();

  const sidebar = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
  await expect(sidebar).toBeVisible();
  await sidebar.evaluate((element) => {
    const dispatch = (type: string, clientX: number) => {
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX,
          clientY: 420,
          isPrimary: true,
          pointerId: 1,
          pointerType: "touch",
        }),
      );
    };
    dispatch("pointerdown", 140);
    dispatch("pointermove", 72);
    dispatch("pointerup", 72);
  });

  await expect(sidebar).not.toBeVisible();
});

test("swiping inward from the right edge opens a populated side sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const editor = page.locator(".cm-content");
  const capture = page.locator("header").getByRole("button", { name: "Capture a thought" });

  await capture.click();
  await expect(editor).toBeVisible();
  await editor.fill("# Target");
  await page.waitForTimeout(800);

  await capture.click();
  await expect(editor).toBeVisible();
  await editor.fill("See [[Untitled]] for details.");
  await page.waitForTimeout(800);

  await swipe(page, 8, 420, 72, 428);
  const sidebar = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name: "Untitled", exact: true }).click();

  await swipe(page, 382, 420, 318, 428);

  await expect(page.getByRole("heading", { name: "Backlinks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Untitled 2", exact: true })).toBeVisible();
});
