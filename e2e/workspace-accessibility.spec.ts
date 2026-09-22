import { expect, test } from "@playwright/test";

test("workspace tabs use roving focus and manual activation", async ({ page }) => {
  await page.goto("/");
  const capture = page.locator("header").getByRole("button", { name: "Capture a thought" });
  await capture.click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await capture.click();

  const first = page.getByRole("tab", { name: "Untitled", exact: true });
  const second = page.getByRole("tab", { name: "Untitled 2", exact: true });
  await expect(second).toBeVisible();
  await second.focus();

  await page.keyboard.press("ArrowLeft");
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-selected", "false");
  await expect(second).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("End");
  await expect(second).toBeFocused();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(second).toHaveAttribute("aria-selected", "false");
});

test("pane actions stay behind one options menu", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pane options" }).click();
  await expect(page.getByRole("menuitem", { name: "Split right" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Split down" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Close pane" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("mobile presents split panes through an accessible picker", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.getByRole("button", { name: "Pane options" }).click();
  await page.getByRole("menuitem", { name: "Split right" }).click();

  await expect(page.locator("[data-workspace-pane]")).toHaveCount(1);
  const picker = page.getByRole("button", { name: /^Switch pane/ });
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(page.getByRole("menuitem", { name: /Pane 1/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Pane 2/ })).toBeVisible();
});
