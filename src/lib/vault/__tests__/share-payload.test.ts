import { describe, it, expect } from "vitest";
import { shareToCaptures } from "@/lib/vault/share-payload";

describe("shareToCaptures", () => {
  it("builds a heading + text + url note from a text share", () => {
    const [capture] = shareToCaptures({
      title: "Cool article",
      text: "Worth reading later",
      url: "https://example.com/article",
    });
    expect(capture.name).toBe("Cool article.md");
    expect(capture.markdown).toBe(
      "# Cool article\n\nWorth reading later\n\nhttps://example.com/article",
    );
  });

  it("falls back to a generic name when there's no title", () => {
    const [capture] = shareToCaptures({ text: "just some text" });
    expect(capture.name).toBe("Shared note.md");
    expect(capture.markdown).toBe("just some text");
  });

  it("omits empty sections rather than leaving blank lines", () => {
    const [capture] = shareToCaptures({ title: "Only a title" });
    expect(capture.markdown).toBe("# Only a title");
  });

  it("prefers shared files over title/text/url, one capture per file", () => {
    const captures = shareToCaptures({
      title: "ignored",
      files: [
        { name: "notes.md", content: "# notes" },
        { name: "todo.txt", content: "- [ ] one" },
      ],
    });
    expect(captures).toEqual([
      { name: "notes.md", markdown: "# notes" },
      { name: "todo.md", markdown: "- [ ] one" },
    ]);
  });

  it("sanitizes an unsafe shared file name", () => {
    const [capture] = shareToCaptures({ files: [{ name: "a/b:c.md", content: "x" }] });
    expect(capture.name).not.toMatch(/[/:]/);
    expect(capture.name.endsWith(".md")).toBe(true);
  });
});
