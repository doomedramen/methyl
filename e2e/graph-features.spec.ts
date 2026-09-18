import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * Graph editor feature coverage (SPEC §37 editor surfaces):
 *  - The "+" button is a node-type dropdown (Note / To-do).
 *  - To-do nodes are checkable, and the done state persists to the layout
 *    file (the Mermaid source has no slot for it).
 *  - Edges render animated/dashed by default; the toolbar toggle turns the
 *    animation off and persists the preference.
 *  - The MiniMap renders on desktop viewports only.
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

async function addNote(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("menuitem", { name: "Note" }).click();
}

async function addTodo(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("menuitem", { name: "To-do" }).click();
}

async function readLayoutFile(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle("adhd-vault");
    const adhd = await vault.getDirectoryHandle(".adhd", { create: true });
    const meta = await adhd.getDirectoryHandle("vault-meta", { create: true });
    return (await (await meta.getFileHandle("graph-layout.json")).getFile()).text();
  });
}

test("the + button is a dropdown offering Note and To-do node types", async ({ page }) => {
  const pane = await newGraph(page);
  await page.getByRole("button", { name: "Add node" }).click();
  await expect(page.getByRole("menuitem", { name: "Note" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "To-do" })).toBeVisible();
  await page.getByRole("menuitem", { name: "To-do" }).click();
  await expect(pane.getByRole("checkbox", { name: "Mark done" })).toBeVisible();
});

test("to-do done state persists to the layout file", async ({ page }) => {
  const pane = await newGraph(page);
  await addTodo(page);
  const box = pane.getByRole("checkbox", { name: "Mark done" });
  await box.check();
  await expect(box).toBeChecked();
  await page.waitForTimeout(700);
  const layout = await readLayoutFile(page);
  expect(layout).toContain('"meta"');
  expect(layout).toContain('"done":true');
  expect(layout).toContain('"kind":"todo"');
});

test("edges are animated/dashed by default and the toggle persists", async ({ page }) => {
  const pane = await newGraph(page);
  await addNote(page);
  await addNote(page);
  await expect(pane.locator(".react-flow__node")).toHaveCount(2);

  const nodes = pane.locator(".react-flow__node");
  const n0 = await nodes.nth(0).boundingBox();
  const n1 = await nodes.nth(1).boundingBox();
  const source = { x: n0!.x + n0!.width / 2, y: n0!.y + n0!.height };
  const target = { x: n1!.x + n1!.width / 2, y: n1!.y };
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 20 });
  await page.mouse.up();
  await expect(pane.locator(".react-flow__edge.animated")).toHaveCount(1);

  const toggle = page.getByRole("button", { name: "Animated edges" });
  await toggle.click();
  await expect(pane.locator(".react-flow__edge.animated")).toHaveCount(0);
  await expect(pane.locator(".react-flow__edge")).toHaveCount(1);
  await page.waitForTimeout(700);
  expect(await readLayoutFile(page)).toContain('"animatedEdges":false');
});

test("MiniMap renders on desktop only", async ({ page }) => {
  await newGraph(page);
  await expect(page.locator(".react-flow__minimap")).toHaveCount(1);
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
});

test("toolbar buttons show tooltips anchored below them", async ({ page }) => {
  await newGraph(page);
  const btn = page.getByRole("button", { name: "Auto arrange" });
  await btn.hover();
  await expect(page.getByText("Auto arrange")).toBeVisible();
  const btnBox = (await btn.boundingBox())!;
  await expect
    .poll(async () => (await page.getByText("Auto arrange").boundingBox())?.y ?? -Infinity)
    .toBeGreaterThan(btnBox.y + btnBox.height - 2);
  const tipBox = (await page.getByText("Auto arrange").boundingBox())!;
  expect(tipBox.x + tipBox.width / 2).toBeGreaterThan(btnBox.x);
  expect(tipBox.x + tipBox.width / 2).toBeLessThan(btnBox.x + btnBox.width);
});

test("context menu converts a note to a to-do and back, persisting kind", async ({ page }) => {
  const pane = await newGraph(page);
  await addNote(page);
  const node = pane.locator(".react-flow__node").first();
  await expect(pane.getByRole("checkbox", { name: "Mark done" })).toHaveCount(0);

  await node.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Convert to to-do" }).click();
  await expect(pane.getByRole("checkbox", { name: "Mark done" })).toBeVisible();
  await page.waitForTimeout(700);
  expect(await readLayoutFile(page)).toContain('"kind":"todo"');

  await node.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Convert to note" }).click();
  await expect(pane.getByRole("checkbox", { name: "Mark done" })).toHaveCount(0);
  await page.waitForTimeout(700);
  expect(await readLayoutFile(page)).toContain('"kind":"graph"');
});