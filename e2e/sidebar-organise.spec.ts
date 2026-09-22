import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * These tests drive the real sidebar drag-and-drop with actual mouse
 * events, in a real Chromium layout engine — the three bugs this suite
 * guards against (drop-into-folder computed only on row change, and the
 * Loro remove-then-reinsert index overshoot on downward moves) are only
 * visible when dnd-kit's pointer-based hit-testing runs against real
 * measured DOM rects. jsdom has no layout, so unit tests can't see them
 * (see src/components/vault/__tests__/sidebar-dnd.test.ts for the pure
 * placement resolver coverage).
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

/** The sidebar's own root — scopes add/folder controls away from the
 *  editor header. */
function sidebar(page: Page): Locator {
  return page.locator('[data-slot="sidebar-inner"]');
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // Wait for the vault engine to finish booting: the add menu is only
  // enabled once an engine exists.
  await expect(sidebar(page).getByRole("button", { name: "Add" })).toBeEnabled();
});

// --- OPFS file listing -------------------------------------------------

async function walkVaultFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
      const entries = (
        dir as unknown as {
          entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
        }
      ).entries();
      for await (const [name, handle] of entries) {
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
    await page
      .getByRole("menu", { name: `Actions for ${parent}` })
      .getByRole("menuitem", { name: "New note" })
      .click();
  } else {
    await sidebar(page).getByRole("button", { name: "Add" }).click();
    await page.getByRole("menuitem", { name: "New note" }).click();
  }
  // New notes are created as "Untitled" (auto-suffixed on clash); rename to
  // the wanted title via the row action menu.
  const untitled = page.locator('li[data-slot="sidebar-menu-item"]').filter({
    has: page.getByText(/^Untitled( \d+)?$/),
  }).first();
  const currentName = (await untitled.locator("span").filter({ hasText: /^Untitled/ }).first().textContent())!.trim();
  await untitled.locator(`button[aria-label="Actions for ${currentName}"]`).click();
  await page
    .getByRole("menu", { name: `Actions for ${currentName}` })
    .getByRole("menuitem", { name: "Rename" })
    .click();
  const input = page.locator("#rename-note-title");
  await input.fill(title);
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(rowByName(page, title)).toBeVisible();
}

async function createFolder(page: Page, name: string) {
  await sidebar(page).getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "New folder" }).click();
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
async function dragRow(
  page: Page,
  fromName: string,
  toName: string,
  position: DropPosition,
) {
  const from = rowByName(page, fromName);
  const to = rowByName(page, toName);
  const toBox = (await to.boundingBox())!;
  let targetY: number;
  if (position === "before") targetY = toBox.y + toBox.height * 0.1;
  else if (position === "after") targetY = toBox.y + toBox.height * 0.9;
  else targetY = toBox.y + toBox.height * 0.5;
  await dragBetween(page, from, to, targetY);
}

async function dragRowAfterFolder(page: Page, fromName: string, folderName: string, horizontalOffset = 0) {
  const from = rowByName(page, fromName);
  const dropZone = page.locator(
    `[data-sidebar-drop-zone="after-folder"][data-sidebar-drop-folder="${folderName}"]`,
  );
  await expect(dropZone).toHaveCount(1);
  const dropZoneBox = (await dropZone.boundingBox())!;
  await dragBetween(
    page,
    from,
    dropZone,
    dropZoneBox.y + dropZoneBox.height / 2,
    dropZoneBox.x + dropZoneBox.width / 2 + horizontalOffset,
  );
}

async function dragBetween(
  page: Page,
  from: Locator,
  to: Locator,
  targetY: number,
  targetXOverride?: number,
) {
  const fromBox = (await from.boundingBox())!;
  const toBox = (await to.boundingBox())!;

  const startX = fromBox.x + fromBox.width / 2;
  const startY = fromBox.y + fromBox.height / 2;
  const targetX = targetXOverride ?? toBox.x + toBox.width / 2;

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

/** Same real pointer path as dragBetween, but leaves the pointer held so the
 * preview can be inspected before the commit. */
async function dragToHold(page: Page, from: Locator, to: Locator, targetY: number) {
  const fromBox = (await from.boundingBox())!;
  const toBox = (await to.boundingBox())!;
  const startX = fromBox.x + fromBox.width / 2;
  const startY = fromBox.y + fromBox.height / 2;
  const targetX = toBox.x + toBox.width / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 15, { steps: 3 });
  for (let i = 1; i <= 8; i += 1) {
    const x = startX + ((targetX - startX) * i) / 8;
    const y = startY + 15 + ((targetY - startY - 15) * i) / 8;
    await page.mouse.move(x, y, { steps: 2 });
    await page.waitForTimeout(20);
  }
  await page.mouse.move(targetX, targetY, { steps: 2 });
  await page.waitForTimeout(100);
}

// --------------------------------------------------------------------------

test("create a folder and two notes", async ({ page }) => {
  await createFolder(page, "Folder One");
  await createNote(page, "Note A");
  await createNote(page, "Note B");

  await expect(rowByName(page, "Folder One")).toBeVisible();
  await expect(rowByName(page, "Note A")).toBeVisible();
  await expect(rowByName(page, "Note B")).toBeVisible();
  const rows = page.locator('li[data-slot="sidebar-menu-item"] span').filter({
    hasText: /^(Folder One|Note A|Note B)$/,
  });
  await expect(rows).toHaveText(["Folder One", "Note A", "Note B"]);

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

test("a drop over a middle folder child stays inside that folder", async ({ page }) => {
  await createFolder(page, "People");
  await createNote(page, "Hana", "People");
  await createNote(page, "Work", "People");
  await createNote(page, "Later", "People");
  await createNote(page, "Garage");

  await dragRow(page, "Garage", "Work", "after");

  await expect
    .poll(async () => rowIndentPx(rowByName(page, "Garage")))
    .toBeGreaterThan(await rowIndentPx(rowByName(page, "People")));
  expect(await listVaultFiles(page)).toContain("People/Garage.md");
  expect(await listVaultFiles(page)).not.toContain("Garage.md");
});

test("uses one shared boundary after an expanded folder", async ({ page }) => {
  await createFolder(page, "People");
  await createNote(page, "Hana", "People");
  await createNote(page, "Garage");

  const target = rowByName(page, "Garage");
  const targetBox = (await target.boundingBox())!;
  await dragToHold(page, rowByName(page, "Hana"), target, targetBox.y + targetBox.height * 0.1);

  await expect(page.locator('[data-sidebar-placement-label="true"]')).toHaveText(
    "At vault root · after People",
  );
  await expect(page.locator('[data-sidebar-drop-line="true"]')).toHaveCount(1);
  await expect(page.locator('[data-sidebar-drop-line="true"][data-sidebar-drop-depth="0"]')).toBeVisible();

  await page.mouse.up();
  const peopleIndent = await rowIndentPx(rowByName(page, "People"));
  await expect
    .poll(async () => rowIndentPx(rowByName(page, "Hana")))
    .toBe(peopleIndent);
  expect(await listVaultFiles(page)).toContain("Hana.md");
  expect(await listVaultFiles(page)).not.toContain("People/Hana.md");
});

test("drag preview exposes the projected depth and full destination path", async ({ page }) => {
  await createFolder(page, "People");
  await createFolder(page, "Projects");
  await dragRow(page, "Projects", "People", "inside");
  await createNote(page, "Garage");

  const target = rowByName(page, "Projects");
  const targetBox = (await target.boundingBox())!;
  await dragToHold(page, rowByName(page, "Garage"), target, targetBox.y + targetBox.height / 2);

  const preview = page.locator('[data-sidebar-drag-preview="true"]');
  await expect(preview).toBeVisible();
  await expect(preview.locator('[data-sidebar-placement-label="true"]')).toHaveText(
    "In People / Projects · at end",
  );
  await expect(preview).toHaveAttribute("data-sidebar-placement-depth", "2");
  await expect(page.locator('[data-sidebar-drop-line="true"]')).toHaveCount(1);
  await expect(page.locator('[data-sidebar-drop-line="true"][data-sidebar-drop-depth="2"]')).toBeVisible();
  await expect(target.locator('[data-sidebar-drop-parent="true"]')).toBeVisible();

  await page.mouse.up();
  await expect
    .poll(async () => rowIndentPx(rowByName(page, "Garage")))
    .toBeGreaterThan(await rowIndentPx(target));
  expect(await listVaultFiles(page)).toContain("People/Projects/Garage.md");
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

test("moves a root note below an expanded folder", async ({ page }) => {
  await createNote(page, "Garage");
  await createFolder(page, "People");
  await createNote(page, "Hana", "People");

  await dragRow(page, "Garage", "People", "after");

  const rows = page.locator('li[data-slot="sidebar-menu-item"] span').filter({
    hasText: /^(Garage|Hana|People)$/,
  });
  await expect(rows).toHaveText(["People", "Hana", "Garage"]);
  expect(await rowIndentPx(rowByName(page, "Garage"))).toBe(
    await rowIndentPx(rowByName(page, "People")),
  );
});

test("moves a note out of an expanded folder to just below its parent", async ({ page }) => {
  await createFolder(page, "People");
  await createNote(page, "Hana", "People");
  await createNote(page, "Garage", "People");

  // Drop on the explicit boundary after the expanded subtree so the note
  // leaves People instead of being inserted among its children.
  await dragRowAfterFolder(page, "Garage", "People");

  const rows = page.locator('li[data-slot="sidebar-menu-item"] span').filter({
    hasText: /^(Garage|Hana|People)$/,
  });
  await expect(rows).toHaveText(["People", "Hana", "Garage"]);
  expect(await rowIndentPx(rowByName(page, "Garage"))).toBe(
    await rowIndentPx(rowByName(page, "People")),
  );
});

test("horizontal movement changes depth at the folder boundary", async ({ page }) => {
  await createNote(page, "Garage");
  await createFolder(page, "People");
  await createNote(page, "Hana", "People");

  await dragRowAfterFolder(page, "Garage", "People", 25);

  const garage = rowByName(page, "Garage");
  const people = rowByName(page, "People");
  expect(await rowIndentPx(garage)).toBeGreaterThan(await rowIndentPx(people));
  expect(await listVaultFiles(page)).toContain("People/Garage.md");
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

test("keeps files alphabetized after same-folder reorder gestures", async ({ page }) => {
  await createFolder(page, "Folder One");
  await createNote(page, "Note A", "Folder One");
  await createNote(page, "Note B", "Folder One");

  const rowsIn = () =>
    page.locator('li[data-slot="sidebar-menu-item"] span').filter({ hasText: /^(Note A|Note B)$/ });

  await expect(rowsIn()).toHaveText(["Note A", "Note B"]);

  // The gesture is still accepted by the tree interaction, but display order
  // remains automatic rather than reflecting manual sibling placement.
  await dragRow(page, "Note B", "Note A", "before");
  await expect(rowsIn()).toHaveText(["Note A", "Note B"]);
  await expect
    .poll(async () => rowIndentPx(rowByName(page, "Note B")))
    .toBeGreaterThan(await rowIndentPx(rowByName(page, "Folder One")));

  // Moving it back does not change the automatic order either.
  const noteATarget = rowByName(page, "Note A");
  const noteATargetBox = (await noteATarget.boundingBox())!;
  await dragToHold(
    page,
    rowByName(page, "Note B"),
    noteATarget,
    noteATargetBox.y + noteATargetBox.height * 0.9,
  );
  await expect(page.locator('[data-sidebar-placement-label="true"]')).toHaveText(
    "In Folder One · after Note A",
  );
  await page.mouse.up();
  await expect
    .poll(async () => page.locator('li[data-slot="sidebar-menu-item"] [style*="opacity: 0"]').count())
    .toBe(0);
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

  await expect(page.getByText("Cannot move into own folder")).toBeVisible();

  // Tree unchanged: Parent Folder still at root, Child Folder still nested.
  const parentIndentAfter = await rowIndentPx(rowByName(page, "Parent Folder"));
  const childIndentAfter = await rowIndentPx(rowByName(page, "Child Folder"));
  expect(parentIndentAfter).toBe(parentIndent);
  expect(childIndentAfter).toBe(childIndentBefore);
});

test("keyboard sibling reorder keeps files alphabetized", async ({ page }) => {
  await createNote(page, "Note A");
  await createNote(page, "Note B");

  const noteB = rowByName(page, "Note B").locator('[data-sidebar-drag-row="true"]');
  await noteB.focus();
  await noteB.press("Space");
  await expect(page.locator('[data-sidebar-drag-preview="true"]')).toBeVisible();
  await noteB.press("ArrowUp");
  await expect(page.locator('[data-sidebar-placement-label="true"]')).toContainText(
    "before Note A",
  );
  await noteB.press("Space");

  const rows = page.locator('li[data-slot="sidebar-menu-item"] span').filter({
    hasText: /^(Note A|Note B)$/,
  });
  await expect(rows).toHaveText(["Note A", "Note B"]);
});

test("keyboard right changes the destination depth", async ({ page }) => {
  await createNote(page, "Garage");
  await createFolder(page, "People");

  const garage = rowByName(page, "Garage").locator('[data-sidebar-drag-row="true"]');
  await garage.focus();
  await garage.press("Space");
  // Folders are displayed before files, so People is above Garage.
  await garage.press("ArrowUp");
  await garage.press("ArrowRight");
  await expect(page.locator('[data-sidebar-placement-label="true"]')).toContainText(
    "In People · at end",
  );
  await expect(page.locator('[data-sidebar-drag-preview="true"]')).toHaveAttribute(
    "data-sidebar-placement-depth",
    "1",
  );
  await garage.press("Space");

  await expect
    .poll(async () => rowIndentPx(rowByName(page, "Garage")))
    .toBeGreaterThan(await rowIndentPx(rowByName(page, "People")));
});
