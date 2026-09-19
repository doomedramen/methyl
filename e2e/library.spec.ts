import { expect, test } from "@playwright/test";

test("Inbox creation, renaming, and collection navigation preserve the note", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header").getByRole("button", { name: "Capture a thought" })).toBeEnabled();
  const collections = page.getByRole("navigation", { name: "Collections" });
  await collections.getByRole("button", { name: /^Inbox/ }).click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.locator(".note-heading > p")).toHaveText("Inbox");
  const editor = page.locator(".cm-content");
  await editor.fill("Keep this thought while browsing collections.");
  await page.getByRole("button", { name: "Rename Untitled", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("A captured thought");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(editor).toContainText("Keep this thought");
  await collections.getByRole("button", { name: /^All notes/ }).click();
  await expect(page.getByRole("heading", { name: "Recently opened" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "A captured thought" })).toBeVisible();
  await collections.getByRole("button", { name: /^Inbox/ }).click();
  await page.locator(".library-page").getByRole("button", { name: "A captured thought", exact: true }).click();
  await expect(editor).toContainText("Keep this thought while browsing collections.");
  // Reopening the title dialog must use the current filename, not its initial value.
  await page.getByRole("button", { name: "Rename A captured thought", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("A captured thought");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await expect(editor).toContainText("Keep this thought while browsing collections.");
});

test("graph collection filters notes and creates a real graph", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header").getByRole("button", { name: "Capture a thought" })).toBeEnabled();
  const collections = page.getByRole("navigation", { name: "Collections" });
  await collections.getByRole("button", { name: /^Graphs/ }).click();
  await expect(page.getByRole("heading", { name: "No graphs yet" })).toBeVisible();
  await page.getByRole("button", { name: "New graph", exact: true }).click();
  await expect(page.locator(".react-flow")).toBeVisible();
  await collections.getByRole("button", { name: /^Graphs/ }).click();
  await expect(page.locator(".library-note")).toHaveCount(1);
  await expect(page.locator(".library-note")).toContainText("Untitled Graph");
});

test("mobile collections close the drawer and reduced motion suppresses the reveal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("header").getByRole("button", { name: "Capture a thought" })).toBeEnabled();
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await page.getByRole("navigation", { name: "Collections" }).getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.locator('[data-sidebar="sidebar"][data-mobile="true"]')).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  expect(await page.locator(".library-page").evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
