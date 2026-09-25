import { describe, expect, it } from "vitest";
import { planPaste } from "@/lib/editor/smart-paste";
import { htmlToMarkdown } from "@/lib/editor/html-to-markdown";

describe("planPaste", () => {
  const base = { text: "", html: "", selection: "", plain: false };

  it("turns a URL pasted over a selection into a link", () => {
    expect(planPaste({ ...base, text: "https://example.com/a?b=1", selection: "the docs" })).toEqual({
      kind: "link",
      insert: "[the docs](https://example.com/a?b=1)",
    });
  });

  it("escapes brackets in the selection", () => {
    expect(planPaste({ ...base, text: "https://x.io", selection: "a [b]" })).toEqual({
      kind: "link",
      insert: "[a \\[b\\]](https://x.io)",
    });
  });

  it("pastes a URL as it is with nothing selected, or over another URL", () => {
    expect(planPaste({ ...base, text: "https://x.io" }).kind).toBe("default");
    expect(planPaste({ ...base, text: "https://x.io", selection: "https://old.io" }).kind).toBe("default");
  });

  it("converts rich HTML, and leaves plain-ish HTML to the text", () => {
    expect(planPaste({ ...base, text: "Hi", html: "<p>Hi <strong>there</strong></p>" }).kind).toBe("html");
    expect(planPaste({ ...base, text: "Hi", html: "<span>Hi</span>" }).kind).toBe("default");
  });

  it("with Shift, always pastes the plain text", () => {
    expect(planPaste({ ...base, text: "https://x.io", selection: "x", plain: true }).kind).toBe("default");
    expect(planPaste({ ...base, text: "Hi", html: "<b>Hi</b>", plain: true }).kind).toBe("default");
  });
});

describe("htmlToMarkdown", () => {
  it("keeps structure and drops styling", () => {
    const md = htmlToMarkdown(
      '<h2 style="color:red">Title</h2><p>Some <strong>bold</strong>, <em>italic</em> and ' +
        '<a href="https://example.com">a link</a>.</p><ul><li>one</li><li>two</li></ul>',
    );
    expect(md).toBe("## Title\n\nSome **bold**, *italic* and [a link](https://example.com).\n\n- one\n- two");
  });

  it("converts tables and code", () => {
    const md = htmlToMarkdown(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>" +
        "<pre><code>let x = 1;</code></pre>",
    );
    expect(md).toContain("| A | B |");
    expect(md).toContain("| 1 | 2 |");
    expect(md).toContain("```\nlet x = 1;\n```");
  });

  it("drops scripts", () => {
    expect(htmlToMarkdown("<p>ok</p><script>alert(1)</script>")).toBe("ok");
  });
});
