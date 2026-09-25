import { test, expect } from "@playwright/test";

/** Spec item 12: the build reports one version, in /healthz and in the app. */
test("the server and the app report the same version", async ({ page, request }) => {
  const health = (await (await request.get("/healthz")).json()) as { version?: string };
  expect(health.version).toMatch(/^\d+\.\d+\.\d+/);

  await page.goto("/");
  const footer = page.locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: /offline|online|Sync/i }).first().click();
  await expect(page.getByText(`Methyl ${health.version}`, { exact: true })).toBeVisible();
});
