import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * Graph editor layout coverage:
 *  - The Add-node toolbar button adds a node that always lands inside the
 *    viewport (regression guard against nodes being placed off-pane).
 *  - Double-clicking the pane adds a node at the cursor position.
 *  - Auto arrange lays out the current nodes and persists the layout.
 *  - Cmd+S shows the "Saved" badge, and again when already saved.
 */

async function openVault(page: Page): Promise<Locator> {
  await page.goto("/");
  await page.waitForTimeout(1200);
  return page.locator('[data-slot="sidebar-inner"]');
}

async function newGraph(page: Page): Promise<Locator> {
  const sb = await openVault(page);
  await sb.getByRole("button", { name: "New graph" }).click();
  const pane = page.locator(".react-flow");
  await expect(pane).toBeVisible();
  return pane;
}

async function inside(el: Locator, at: { x: number; y: number }): Promise<boolean> {
  const b = (await el.boundingBox())!;
  return at.x >= b.x && at.x <= b.x + b.width && at.y >= b.y && at.y <= b.y + b.height;
}

test("Add-note keeps every node inside the viewport", async ({ page }) => {
  const pane = await newGraph(page);
  for (let i = 0; i < 6; i++) {
    await page.getByRole("button", { name: "Add node" }).click();
  }
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  for (const node of await page.locator(".react-flow__node").all()) {
    const b = (await node.boundingBox())!;
    expect(await inside(pane, { x: b.x + b.width / 2, y: b.y + b.height / 2 })).toBe(true);
  }
});

test("double-click on the pane adds a node at the cursor", async ({ page }) => {
  const pane = await newGraph(page);
  const p = (await pane.boundingBox())!;
  await page.mouse.dblclick(p.x + 340, p.y + 140);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  const nb = (await page.locator(".react-flow__node").boundingBox())!;
  expect(Math.abs(nb.x - (p.x + 340))).toBeLessThan(64);
});

test("auto-arrange lays nodes out and persists the layout", async ({ page }) => {
  await newGraph(page);
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("button", { name: "Add node" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  const btn = page.getByRole("button", { name: "Auto arrange" });
  await expect(btn).toBeVisible();
  await btn.click();
  await page.waitForTimeout(700);
  const files = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle("adhd-vault");
    const adhd = await vault.getDirectoryHandle(".adhd", { create: true });
    const meta = await adhd.getDirectoryHandle("vault-meta", { create: true });
    return (await (await meta.getFileHandle("graph-layout.json")).getFile()).text();
  });
  expect(files).toContain('"nodes"');
});

test("Cmd+S shows the Saved badge, and again when already saved", async ({ page }) => {
  await newGraph(page);
  await page.getByRole("button", { name: "Add node" }).click();
  await page.keyboard.press("Meta+s");
  await expect(page.getByText("Saved")).toBeVisible();
  await expect(page.getByText("Saved")).toBeHidden({ timeout: 4000 });
  await page.keyboard.press("Meta+s");
  await expect(page.getByText("Saved")).toBeVisible();
});
