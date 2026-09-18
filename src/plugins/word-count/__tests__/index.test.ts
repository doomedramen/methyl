import { describe, expect, it } from "vitest";
import { countWords } from "@/plugins/word-count";

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("hello world  foo", { includeFrontmatter: true })).toBe(3);
  });

  it("excludes frontmatter by default", () => {
    const doc = "---\ntitle: X\n---\nhello world";
    expect(countWords(doc, { includeFrontmatter: false })).toBe(2);
  });

  it("includes frontmatter when includeFrontmatter is true", () => {
    const doc = "---\ntitle: X\n---\nhello world";
    expect(countWords(doc, { includeFrontmatter: true })).toBeGreaterThan(2);
  });

  it("returns 0 for empty text", () => {
    expect(countWords("", { includeFrontmatter: true })).toBe(0);
  });
});
