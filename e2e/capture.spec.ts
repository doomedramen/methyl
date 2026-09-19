import { expect, test } from "@playwright/test";

test("header capture opens one focused Inbox note and preserves the previous tab", async ({ page }) => {
  await page.goto("/");
  const capture = page.locator("header").getByRole("button", { name: "Capture a thought" });
  await expect(capture).toBeEnabled();

  await capture.click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await editor.fill("Keep this note open.");
  await expect(page.getByText("Saved")).toBeVisible();

  await capture.click();
  await expect(page.getByRole("tab", { name: "Untitled 2", exact: true })).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(
    page.locator('[data-slot="sidebar-inner"]').getByRole("button", { name: "Untitled 2", exact: true }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Untitled", exact: true }).click();
  await expect(editor).toContainText("Keep this note open.");
});

test("rapid capture activation creates only one note", async ({ page }) => {
  await page.goto("/");
  const capture = page.locator("header").getByRole("button", { name: "Capture a thought" });
  await expect(capture).toBeEnabled();

  await capture.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });

  await expect(page.getByRole("tab", { name: "Untitled", exact: true })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Untitled 2", exact: true })).toHaveCount(0);
});
