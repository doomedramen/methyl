import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * These tests drive the real sidebar drag-and-drop with actual mouse
 * events, in a real Chromium layout engine — the three bugs this suite
 * guards against (drop-into-folder computed only on row change, and the
 * Loro remove-then-reinsert index overshoot on downward moves) are only
 * visible when dnd-kit's pointer-based hit-testing runs against real
 * measured DOM rects. jsdom has no layout, so unit tests can't see them
 * (see src/components/vault/__tests__/AppSidebar.dnd.test.ts, which only
 * covers the pure computeDropMode()/index-math helpers).
 *
 * Each test gets a brand-new, isolated Playwright BrowserContext (the
 * default `page` fixture), which is a fresh browser storage partition —
 * OPFS, localStorage and IndexedDB are all empty, so every test starts
 * from a clean vault with no manual reset step needed. No sync server is
 * configured, so the app seeds a "Welcome" note on first load (see
 * getVault() in src/lib/browser/vault.ts); tests never assert on its
 * content, only on the rows/files they create themselves.
 *
 * File assertions read straight from the browser's OPFS
 * (navigator.storage.getDirectory(), root directory "adhd-vault") via
 * page.evaluate — there is no server-side vault directory in this setup
 * (see playwright.config.ts for why the sync server isn't used).
 */

/** The sidebar's own root — scopes "New note"/"New folder" lookups away
 *  from the editor header, which has its own "New note" button in the
 *  empty state. */
function sidebar(page: Page): Locator {
  return page.locator('[data-slot="sidebar-inner"]');
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // Wait for the vault engine to finish booting: "New note" is only
  // enabled once an engine exists.
  await expect(sidebar(page).getByRole("button", { name: "New note" })).toBeEnabled();
});

// --- OPFS file listing -------------------------------------------------

async function walkVaultFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
      for await (const [name, handle] of (dir as any).entries()) {
        if (prefix === "" && (name === ".adhd" || name === ".trash")) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "directory") {
          await walk(handle as FileSystemDirectoryHandle, path);
        } else {
          out.push(path);
        }
      }
    }
    const root = await navigator.storage.getDirectory();
    const vaultRoot = await root.getDirectoryHandle("adhd-vault");
    await walk(vaultRoot, "");
    return out.sort();
  });
}

/** All materialized note paths in the vault, relative to its root, sorted.
 *  Skips the app's own bookkeeping (`.adhd/`, `.trash/`). Writes go
 *  tmp-file → rename (see OpfsVaultFS in src/lib/vault/opfs.ts), so right
 *  after a UI action there can briefly be `*.md.tmp`/`*.tmp.crswap`
 *  leftovers in the listing; poll until the tree is quiescent (no `.tmp`
 *  entries) instead of asserting on a mid-write snapshot. */
async function listVaultFiles(page: Page): Promise<string[]> {
  await expect
    .poll(async () => (await walkVaultFiles(page)).some((f) => f.includes(".tmp")), {
      timeout: 5_000,
    })
    .toBe(false);
  return walkVaultFiles(page);
}

// --- sidebar row helpers -------------------------------------------------

function rowByName(page: Page, name: string): Locator {
  return page.locator('li[data-slot="sidebar-menu-item"]').filter({
    has: page.getByText(name, { exact: true }),
  });
}

/** Row indent, in rem, derived from the row's own inline padding-left
 *  (`${depth * 1.1}rem`, see AppSidebar.tsx's `indent` style) — used to
 *  assert nesting depth without relying on internal class names. */
async function rowIndentPx(row: Locator): Promise<number> {
  const el = row.locator('[style*="padding-left"]').first();
  const style = await el.getAttribute("style");
  const match = style?.match(/padding-left:\s*([\d.]+)rem/);
  return match ? parseFloat(match[1]) : 0;
}

async function createNote(page: Page, title: string, parent?: string) {
  if (parent) {
    const folderRow = rowByName(page, parent);
    await folderRow.locator(`button[aria-label="Actions for ${parent}"]`).click();
    await page.getByRole("menuitem", { name: "New note" }).click();
  } else {
    await sidebar(page).getByRole("button", { name: "New note" }).click();
  }
  // New notes are created as "Untitled" (auto-suffixed on clash); rename to
  // the wanted title via the row action menu.
  const untitled = page.locator('li[data-slot="sidebar-menu-item"]').filter({
    has: page.getByText(/^Untitled( \d+)?$/),
  }).first();
  const currentName = (await untitled.locator("span").filter({ hasText: /^Untitled/ }).first().textContent())!.trim();
  await untitled.locator(`button[aria-label="Actions for ${currentName}"]`).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const input = page.locator("#rename-note-title");
  await input.fill(title);
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(rowByName(page, title)).toBeVisible();
}

async function createFolder(page: Page, name: string) {
  await sidebar(page).getByRole("button", { name: "New folder" }).click();
  await page.locator("#new-folder-name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(rowByName(page, name)).toBeVisible();
}

type DropPosition = "before" | "after" | "inside";

/** Drags row `fromName` onto row `toName`, landing before/after/inside it.
 *  Uses real mouse.down()/move()/up() with several intermediate moves —
 *  dnd-kit's MouseSensor has a 6px activation-distance constraint, so a
 *  single `dragTo()` (which jumps straight to the target) never triggers
 *  the drag at all. */
async function dragRow(page: Page, fromName: string, toName: string, position: DropPosition) {
  const from = rowByName(page, fromName);
  const to = rowByName(page, toName);
  const fromBox = (await from.boundingBox())!;
  const toBox = (await to.boundingBox())!;

  const startX = fromBox.x + fromBox.width / 2;
  const startY = fromBox.y + fromBox.height / 2;
  const targetX = toBox.x + toBox.width / 2;
  let targetY: number;
  if (position === "before") targetY = toBox.y + toBox.height * 0.1;
  else if (position === "after") targetY = toBox.y + toBox.height * 0.9;
  else targetY = toBox.y + toBox.height * 0.5;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Clear the activation-distance threshold first.
  await page.mouse.move(startX, startY + 15, { steps: 3 });
  // Then walk toward the target in several steps so dnd-kit's onDragMove
  // (which recomputes drop mode continuously — see AppSidebar.tsx) sees
  // intermediate positions, not just start/end.
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = startX + ((targetX - startX) * i) / steps;
    const y = startY + 15 + ((targetY - startY - 15) * i) / steps;
    await page.mouse.move(x, y, { steps: 2 });
    await page.waitForTimeout(20);
  }
  await page.mouse.move(targetX, targetY, { steps: 2 });
  // Let dnd-kit's onDragMove settle on the final hovered row/mode before
  // releasing — it recomputes continuously (see AppSidebar.tsx), and a
  // drop right on the heels of the last move can race that recompute.
  await page.waitForTimeout(100);
  await page.mouse.up();
  // dnd-kit fades the source row out via an inline `opacity` style while
  // dragging (see the DragOverlay in AppSidebar.tsx) and clears it a tick
  // after drop; without this the very next assertion can read the row
  // mid-fade.
  await expect
    .poll(async () => page.locator('li[data-slot="sidebar-menu-item"] [style*="opacity: 0"]').count(), {
      timeout: 2_000,
    })
    .toBe(0);
}

// --------------------------------------------------------------------------

test("create a folder and two notes", async ({ page }) => {
  await createFolder(page, "Folder One");
  await createNote(page, "Note A");
  await createNote(page, "Note B");

  await expect(rowByName(page, "Folder One")).toBeVisible();
  await expect(rowByName(page, "Note A")).toBeVisible();
  await expect(rowByName(page, "Note B")).toBeVisible();

  const files = await listVaultFiles(page);
  expect(files).toContain("Note A.md");
  expect(files).toContain("Note B.md");
});

test("drag a note into a folder nests it and moves the file", async ({ page }) => {
  await createFolder(page, "Folder One");
  await createNote(page, "Note A");

  await dragRow(page, "Note A", "Folder One", "inside");

  const noteRow = rowByName(page, "Note A");
  const folderRow = rowByName(page, "Folder One");
  await expect(noteRow).toBeVisible();
  await expect
    .poll(async () => (await rowIndentPx(noteRow)) > (await rowIndentPx(folderRow)))
    .toBe(true);

  const files = await listVaultFiles(page);
  expect(files).toContain("Folder One/Note A.md");
  expect(files).not.toContain("Note A.md");
});

test("dragging a note from above a folder to directly below it lands immediately after (regression for the index-overshoot bug)", async ({
  page,
}) => {
  // Order: Note A, Folder One, Note B — drag Note A to just below Folder
  // One. Before the fix, Loro's remove-then-reinsert shifted the target
  // index by one, landing it after Note B instead of right after the
  // folder.
  await createNote(page, "Note A");
  await createFolder(page, "Folder One");
  await createNote(page, "Note B");

  await dragRow(page, "Note A", "Folder One", "after");

  const rows = page.locator('li[data-slot="sidebar-menu-item"] span').filter({
    hasText: /^(Note A|Note B|Folder One)$/,
  });
  await expect(rows).toHaveText(["Folder One", "Note A", "Note B"]);
});

test("dragging a note out of a folder to the row below it leaves the folder (regression for the same overshoot bug)", async ({
  page,
}) => {
  // Order at root: Folder One (containing Note A), Note B. Drag Note A out
  // of the folder to land directly below it, i.e. between Folder One and
  // Note B, at the root.
  await createFolder(page, "Folder One");
  await createNote(page, "Note A", "Folder One");
  await createNote(page, "Note B");

  await dragRow(page, "Note A", "Note B", "before");

  const noteRow = rowByName(page, "Note A");
  const rootRow = rowByName(page, "Note B");
  await expect(noteRow).toBeVisible();
  // Left the folder: same indent as a root-level row.
  expect(await rowIndentPx(noteRow)).toBe(await rowIndentPx(rootRow));

  const rows = page.locator('li[data-slot="sidebar-menu-item"] span').filter({
    hasText: /^(Note A|Note B|Folder One)$/,
  });
  await expect(rows).toHaveText(["Folder One", "Note A", "Note B"]);

  const files = await listVaultFiles(page);
  expect(files).toContain("Note A.md");
  expect(files).not.toContain("Folder One/Note A.md");
});

test("reorder two notes within the same folder, both directions", async ({ page }) => {
  await createFolder(page, "Folder One");
  await createNote(page, "Note A", "Folder One");
  await createNote(page, "Note B", "Folder One");

  const rowsIn = () =>
    page.locator('li[data-slot="sidebar-menu-item"] span').filter({ hasText: /^(Note A|Note B)$/ });

  await expect(rowsIn()).toHaveText(["Note A", "Note B"]);

  // Move B above A.
  await dragRow(page, "Note B", "Note A", "before");
  await expect(rowsIn()).toHaveText(["Note B", "Note A"]);

  // Move B back below A.
  await dragRow(page, "Note B", "Note A", "after");
  await expect(rowsIn()).toHaveText(["Note A", "Note B"]);

  const files = await listVaultFiles(page);
  expect(files).toContain("Folder One/Note A.md");
  expect(files).toContain("Folder One/Note B.md");
});

test("refuses dropping a folder into its own descendant", async ({ page }) => {
  await createFolder(page, "Parent Folder");
  await createFolder(page, "Child Folder", );
  // Nest Child Folder inside Parent Folder first.
  await dragRow(page, "Child Folder", "Parent Folder", "inside");
  await expect(rowByName(page, "Child Folder")).toBeVisible();

  const parentIndent = await rowIndentPx(rowByName(page, "Parent Folder"));
  await expect
    .poll(async () => rowIndentPx(rowByName(page, "Child Folder")))
    .toBeGreaterThan(parentIndent);
  const childIndentBefore = await rowIndentPx(rowByName(page, "Child Folder"));

  // Now try to drag Parent Folder into its own descendant, Child Folder.
  await dragRow(page, "Parent Folder", "Child Folder", "inside");

  await expect(page.getByText("Can't move a folder into its own descendant")).toBeVisible();

  // Tree unchanged: Parent Folder still at root, Child Folder still nested.
  const parentIndentAfter = await rowIndentPx(rowByName(page, "Parent Folder"));
  const childIndentAfter = await rowIndentPx(rowByName(page, "Child Folder"));
  expect(parentIndentAfter).toBe(parentIndent);
  expect(childIndentAfter).toBe(childIndentBefore);
});
