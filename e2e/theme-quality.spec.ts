import { expect, test } from "@playwright/test";

const THEMES = [
  "Light",
  "Obsidian Light",
  "Rosé Pine Dawn",
  "Dark",
  "Obsidian",
  "Nord",
  "Catppuccin Mocha",
] as const;

test("theme palettes preserve active collection hierarchy", async ({ page }) => {
  await page.goto("/");
  const themeButton = page.getByRole("button", { name: "Toggle theme" });
  const activeCollection = page.locator('.collection-link[aria-current="page"]');

  for (const theme of THEMES) {
    await themeButton.click();
    await page.getByRole("menuitem", { name: theme, exact: true }).click();
    await expect(activeCollection).toBeVisible();

    const state = await activeCollection.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        background: styles.backgroundColor,
        color: styles.color,
        fontWeight: styles.fontWeight,
        indicator: styles.boxShadow,
      };
    });

    expect(state.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(state.color).not.toBe("rgba(0, 0, 0, 0)");
    expect(state.fontWeight).toBe("600");
    expect(state.indicator).toContain("inset");
  }
});
