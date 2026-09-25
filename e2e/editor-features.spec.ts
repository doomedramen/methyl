import { test, expect, type Page } from "@playwright/test";

/**
 * Editor features (spec item 18): pasting an image stores it as an
 * attachment and links it, a URL pasted over a selection becomes a link,
 * and the `/` menu inserts blocks.
 */

async function newNote(page: Page) {
  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  await expect(sidebar.getByText("welcome", { exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menuitem", { name: "New note" }).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeFocused();
  return editor;
}

/**
 * The note's Markdown. Live preview hides syntax (link targets, `**`) once
 * the cursor moves off it, so the rendered text isn't the document.
 */
async function docText(page: Page): Promise<string> {
  // What EditorView.findFromDOM reads (CodeMirror internals: .cm-content's
  // tile → root → view). Throws, rather than passing vacuously, if that moves.
  return page.locator(".cm-content").evaluate((el) => {
    type Doc = { state: { doc: { toString(): string } } };
    const view = (el as unknown as { cmTile?: { root?: { view?: Doc } } }).cmTile?.root?.view;
    if (!view) throw new Error("no CodeMirror view on .cm-content");
    return view.state.doc.toString();
  });
}

/** Accept the open completion (CodeMirror ignores Enter for a moment after it opens). */
async function acceptCompletion(page: Page, label: string) {
  await expect(page.locator(".cm-tooltip-autocomplete").getByText(label, { exact: true })).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
}

/** Fire a paste on the editor with the given clipboard contents. */
async function paste(page: Page, data: { text?: string; html?: string; png?: boolean }) {
  await page.locator(".cm-content").evaluate((el, data) => {
    const transfer = new DataTransfer();
    if (data.text) transfer.setData("text/plain", data.text);
    if (data.html) transfer.setData("text/html", data.html);
    if (data.png) {
      // A 1×1 PNG, the way a screenshot arrives: a file called "image.png".
      const bytes = Uint8Array.from(
        atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
        (c) => c.charCodeAt(0),
      );
      transfer.items.add(new File([bytes], "image.png", { type: "image/png" }));
    }
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, data);
}

test("a pasted image is stored as an attachment and linked", async ({ page }) => {
  const editor = await newNote(page);
  await paste(page, { png: true });
  await expect(editor).toContainText(/!\[Pasted image \d{14}\.png\]\(/);
  await expect(page.locator('[data-slot="sidebar-inner"]').getByText(/^Pasted image \d{14}\.png$/)).toBeVisible();
});

test("a URL pasted over a selection becomes a link, and HTML becomes Markdown", async ({ page }) => {
  const editor = await newNote(page);
  await page.keyboard.type("read the docs");
  // Select "the docs".
  for (let i = 0; i < "the docs".length; i++) await page.keyboard.press("Shift+ArrowLeft");
  await paste(page, { text: "https://example.com/docs" });
  await expect.poll(() => docText(page)).toBe("read [the docs](https://example.com/docs)");

  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await paste(page, { text: "Big news", html: "<p><strong>Big</strong> news</p>" });
  await expect.poll(() => docText(page)).toBe("read [the docs](https://example.com/docs)\n**Big** news");
  await expect(editor).toBeFocused();
});

test("the / menu inserts a heading and a task list", async ({ page }) => {
  await newNote(page);
  await page.keyboard.type("/h2");
  await acceptCompletion(page, "Heading 2");
  await page.keyboard.type("Plans");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/todo");
  await acceptCompletion(page, "Task list");
  await page.keyboard.type("buy milk");
  await expect.poll(() => docText(page)).toBe("## Plans\n- [ ] buy milk");
});
