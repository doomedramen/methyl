import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Automated accessibility checks (spec item 17): axe on the main screens and
 * dialogs. Serious and critical violations fail; lesser ones are listed.
 */

async function expectAccessible(page: Page, label: string) {
  // Let open/close animations settle so axe sees the final state.
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = blocking.map(
    (v) =>
      `${v.impact} ${v.id}: ${v.help}\n` +
      v.nodes
        .slice(0, 3)
        .map((n) => `    ${n.target.join(" ")}\n      ${n.html.slice(0, 160)}\n      ${n.failureSummary?.split("\n")[1] ?? ""}`)
        .join("\n"),
  );
  expect(summary, `${label}: serious or critical axe violations`).toEqual([]);
}

/** Open the command menu from the sidebar (the Cmd/Ctrl+K listener can lag the first paint). */
async function openCommandMenu(page: Page) {
  await page.locator('[data-slot="sidebar-inner"]').getByRole("button", { name: "Search notes" }).click();
  await expect(page.locator('[data-slot="command-input"]')).toBeVisible();
}

async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.locator('[data-slot="sidebar-inner"]')).toBeVisible();
  // The welcome note is seeded on first start.
  await expect(page.locator('[data-slot="sidebar-inner"]').getByText("welcome", { exact: true })).toBeVisible();
}

test("the vault with nothing open", async ({ page }) => {
  await openApp(page);
  await expectAccessible(page, "vault");
});

test("a note open in the editor", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-slot="sidebar-inner"]').getByText("welcome", { exact: true }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await expectAccessible(page, "note open");
});

test("the command menu", async ({ page }) => {
  await openApp(page);
  await openCommandMenu(page);
  await expectAccessible(page, "command menu");
});

test("the quick switcher", async ({ page }) => {
  await openApp(page);
  // The shortcut listener can lag the first paint: retry until it opens.
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+o");
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2000 });
  }).toPass();
  await expectAccessible(page, "quick switcher");
});

test("sync settings", async ({ page }) => {
  await openApp(page);
  const footer = page.locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: /offline|online|Sync/i }).first().click();
  await page.getByRole("button", { name: /^Sync/ }).first().click();
  await expect(page.getByRole("dialog", { name: "Sync" })).toBeVisible();
  await expectAccessible(page, "sync settings");
});

test("the templates dialog", async ({ page }) => {
  await openApp(page);
  await openCommandMenu(page);
  await page.locator('[data-slot="command-input"]').fill("Templates: Manage");
  await page.getByRole("option", { name: "Templates: Manage" }).click();
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  await expectAccessible(page, "templates dialog");
});

test("the vault switcher", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-slot="sidebar-inner"]').getByRole("button", { name: /Switch vault/ }).click();
  await expect(page.getByRole("menuitem", { name: "Manage vaults…" })).toBeVisible();
  await expectAccessible(page, "vault switcher");
});
