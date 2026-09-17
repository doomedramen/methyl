import { describe, it, expect } from "vitest";
import { computeLivePreviewSpecs, detectFrontmatter, type TextRange } from "@/lib/editor/live-preview";

function hides(specs: ReturnType<typeof computeLivePreviewSpecs>) {
  return specs.filter((s) => s.kind === "hide") as { kind: "hide"; from: number; to: number }[];
}

function cursorAt(pos: number): TextRange[] {
  return [{ from: pos, to: pos }];
}

describe("computeLivePreviewSpecs", () => {
  it("never modifies the document text", () => {
    const doc = "# Title\n\nSome **bold** and _em_ text.";
    const before = doc;
    computeLivePreviewSpecs(doc, cursorAt(0));
    expect(doc).toBe(before);
  });

  it("hides the heading marker when the cursor is elsewhere", () => {
    const doc = "# Title\nbody";
    const specs = computeLivePreviewSpecs(doc, cursorAt(doc.length));
    const hide = hides(specs);
    expect(hide.some((h) => h.from === 0 && h.to === 2)).toBe(true);
    expect(specs.some((s) => s.kind === "lineClass" && s.class === "cm-lp-h1")).toBe(true);
  });

  it("reveals the heading marker when the cursor touches the heading", () => {
    const doc = "# Title\nbody";
    const specs = computeLivePreviewSpecs(doc, cursorAt(1));
    const hide = hides(specs);
    expect(hide.some((h) => h.from === 0 && h.to === 2)).toBe(false);
  });

  it("reveals when the selection overlaps the heading range without containing the marker", () => {
    const doc = "# Title\nbody";
    const specs = computeLivePreviewSpecs(doc, [{ from: 3, to: 5 }]);
    const hide = hides(specs);
    expect(hide.some((h) => h.from === 0 && h.to === 2)).toBe(false);
  });

  it("hides emphasis marks when untouched and marks the span styled", () => {
    const doc = "a *word* b";
    const specs = computeLivePreviewSpecs(doc, cursorAt(0));
    const hide = hides(specs);
    // '*' at index 2 and 7
    expect(hide.some((h) => h.from === 2 && h.to === 3)).toBe(true);
    expect(hide.some((h) => h.from === 7 && h.to === 8)).toBe(true);
    expect(specs.some((s) => s.kind === "mark" && s.class === "cm-lp-em")).toBe(true);
  });

  it("reveals emphasis marks when cursor is inside", () => {
    const doc = "a *word* b";
    const specs = computeLivePreviewSpecs(doc, cursorAt(4));
    const hide = hides(specs);
    expect(hide.some((h) => h.from === 2 && h.to === 3)).toBe(false);
    expect(hide.some((h) => h.from === 7 && h.to === 8)).toBe(false);
  });

  it("hides link brackets/url and styles the link text", () => {
    const doc = "see [docs](https://example.com) now";
    const specs = computeLivePreviewSpecs(doc, cursorAt(0));
    const link = specs.find((s) => s.kind === "mark" && s.class === "cm-lp-link");
    expect(link).toBeTruthy();
    if (link?.kind === "mark") {
      expect(link.attrs?.["data-lp-url"]).toBe("https://example.com");
    }
    const hide = hides(specs);
    // '[' at 4
    expect(hide.some((h) => h.from === 4 && h.to === 5)).toBe(true);
    // url text hidden
    expect(hide.some((h) => h.from === 11 && h.to === 30)).toBe(true);
  });

  it("renders a task checkbox and strikes done items", () => {
    const doneDoc = "- [x] finished";
    const doneSpecs = computeLivePreviewSpecs(doneDoc, cursorAt(doneDoc.length));
    expect(doneSpecs.some((s) => s.kind === "checkbox" && s.checked)).toBe(true);
    expect(doneSpecs.some((s) => s.kind === "mark" && s.class === "cm-lp-task-done")).toBe(true);

    const openDoc = "- [ ] todo";
    const openSpecs = computeLivePreviewSpecs(openDoc, cursorAt(openDoc.length));
    expect(openSpecs.some((s) => s.kind === "checkbox" && !s.checked)).toBe(true);
  });

  it("strikes the task text (not the empty marker range) when done", () => {
    const doc = "- [x] check me";
    const specs = computeLivePreviewSpecs(doc, cursorAt(doc.length));
    const done = specs.find((s) => s.kind === "mark" && s.class === "cm-lp-task-done");
    expect(done).toBeTruthy();
    if (done?.kind === "mark") {
      expect(done.from).toBeLessThan(done.to);
      expect(doc.slice(done.from, done.to)).toBe("check me");
    }
  });

  it("replaces plain bullet markers with a bullet widget", () => {
    const doc = "- one\n- two";
    const specs = computeLivePreviewSpecs(doc, cursorAt(doc.length));
    const bullets = specs.filter((s) => s.kind === "bullet");
    expect(bullets.length).toBe(2);
  });

  it("does not treat frontmatter as a setext heading", () => {
    const doc = "---\ntitle: Hello\ntags: a\n---\n\n# Real heading\n";
    const fm = detectFrontmatter(doc);
    expect(fm).toEqual({ from: 0, to: 28 });

    const specs = computeLivePreviewSpecs(doc, cursorAt(doc.length));
    // No setext underline styling should appear inside the frontmatter block.
    expect(specs.some((s) => s.kind === "lineClass" && s.class === "cm-lp-setext-underline")).toBe(false);
    // The frontmatter lines get their own muted-metadata class instead.
    const fmLines = specs.filter((s) => s.kind === "lineClass" && s.class === "cm-lp-frontmatter");
    expect(fmLines.length).toBeGreaterThan(0);
    // The real heading further down is still recognized.
    expect(specs.some((s) => s.kind === "lineClass" && s.class === "cm-lp-h1")).toBe(true);
  });

  it("returns null frontmatter detection for a doc without one", () => {
    expect(detectFrontmatter("# Hello\nbody")).toBeNull();
    expect(detectFrontmatter("not frontmatter\n---\n")).toBeNull();
  });
});
