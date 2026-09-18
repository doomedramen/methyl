import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNodeRef } from "@lezer/common";

/**
 * Notion-like live preview for the Markdown editor.
 *
 * HARD CONSTRAINT: the document is never rewritten. Everything here is a
 * CodeMirror decoration (hide / mark / replace-with-widget) computed from
 * the raw text + syntax tree; the underlying LoroText is untouched.
 *
 * The interesting logic — mapping (doc text, selection) to a list of
 * decoration specs — is a pure function (`computeLivePreviewSpecs`) so it
 * can be unit tested without a DOM or an EditorView. The ViewPlugin below
 * is a thin adapter that turns those specs into real CodeMirror
 * decorations, restricted to `view.visibleRanges`.
 */

// ---------------------------------------------------------------------------
// Pure spec computation
// ---------------------------------------------------------------------------

export interface TextRange {
  from: number;
  to: number;
}

export type LivePreviewSpec =
  /** Hide a span of raw markup (still present in the doc, just not rendered). */
  | { kind: "hide"; from: number; to: number }
  /** Dim a span (kept visible, but low emphasis — e.g. code fence markers). */
  | { kind: "dim"; from: number; to: number }
  /** Inline styling over a range. */
  | { kind: "mark"; from: number; to: number; class: string; attrs?: Record<string, string> }
  /** Styling for a whole line (heading size, blockquote border, code bg, ...). */
  | { kind: "lineClass"; pos: number; class: string }
  /** Replace a bullet list marker with a bullet glyph. */
  | { kind: "bullet"; from: number; to: number }
  /** Replace a task marker ("[ ]"/"[x]") with an interactive checkbox. */
  | { kind: "checkbox"; from: number; to: number; checked: boolean }
  /** Replace a "---" horizontal rule with an <hr> widget. */
  | { kind: "hr"; from: number; to: number };

function touches(selection: TextRange[], from: number, to: number): boolean {
  return selection.some((r) => r.from <= to && r.to >= from);
}

/** Leading `---\n ... \n---` block at the very start of the document. */
export function detectFrontmatter(doc: string): TextRange | null {
  if (!doc.startsWith("---")) return null;
  const firstNewline = doc.indexOf("\n");
  if (firstNewline === -1) return null;
  if (doc.slice(0, firstNewline).trim() !== "---") return null;

  let pos = firstNewline + 1;
  while (pos <= doc.length) {
    const nextNewline = doc.indexOf("\n", pos);
    const lineEnd = nextNewline === -1 ? doc.length : nextNewline;
    const line = doc.slice(pos, lineEnd);
    if (line.trim() === "---") {
      return { from: 0, to: lineEnd };
    }
    if (nextNewline === -1) break;
    pos = nextNewline + 1;
  }
  return null;
}

const HEADING_NODES: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
};

function lineStart(doc: string, pos: number): number {
  const nl = doc.lastIndexOf("\n", pos - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Walk the wikilink regex over `doc`, skipping ranges already claimed (code). */
function collectWikilinks(doc: string, claimed: TextRange[]): TextRange[] {
  const out: TextRange[] = [];
  const re = /\[\[([^\]|\n]+?)(\|([^\]\n]+?))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    const from = m.index;
    const to = from + m[0].length;
    if (claimed.some((c) => c.from < to && c.to > from)) continue;
    out.push({ from, to });
  }
  return out;
}

/** Find the `[[...]]` wikilink (if any) whose range contains `pos`. */
export function findWikilinkAt(
  doc: string,
  pos: number,
): { from: number; to: number; target: string } | undefined {
  const re = /\[\[([^\]|\n]+?)(\|([^\]\n]+?))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    const from = m.index;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) {
      return { from, to, target: m[1]!.trim() };
    }
  }
  return undefined;
}

export interface LivePreviewComputeOptions {
  /** Resolve a wikilink target to a document id, or undefined if missing. */
  resolveWikilink?: (target: string) => string | undefined;
}

export function computeLivePreviewSpecs(
  doc: string,
  selection: TextRange[],
  options: LivePreviewComputeOptions = {},
): LivePreviewSpec[] {
  const specs: LivePreviewSpec[] = [];
  const frontmatter = detectFrontmatter(doc);
  const codeRanges: TextRange[] = [];

  if (frontmatter) {
    for (let pos = 0; pos <= frontmatter.to; ) {
      specs.push({ kind: "lineClass", pos, class: "cm-lp-frontmatter" });
      const nl = doc.indexOf("\n", pos);
      if (nl === -1 || nl >= frontmatter.to) break;
      pos = nl + 1;
    }
  }

  const tree = markdownLanguage.parser.parse(doc);
  const cursor = tree.cursor();

  cursor.iterate((node: SyntaxNodeRef) => {
    // A node fully inside the frontmatter block (e.g. the "---"-delimited
    // region getting mis-parsed as a setext heading) is skipped, but we
    // still descend so siblings/children *outside* the block keep working —
    // Document itself always starts at 0, so bailing on descent here would
    // silently drop the rest of the document.
    if (frontmatter && node.from >= frontmatter.from && node.to <= frontmatter.to) {
      return true;
    }

    const name = node.name;

    // ---- Headings (ATX) -------------------------------------------------
    if (name in HEADING_NODES) {
      const level = HEADING_NODES[name];
      const headerMark = node.node.getChild("HeaderMark");
      specs.push({ kind: "lineClass", pos: lineStart(doc, node.from), class: `cm-lp-h${level}` });
      if (headerMark && !touches(selection, node.from, node.to)) {
        let end = headerMark.to;
        while (end < doc.length && (doc[end] === " " || doc[end] === "\t")) end++;
        specs.push({ kind: "hide", from: headerMark.from, to: end });
      }
      return true;
    }

    // ---- Setext headings --------------------------------------------------
    if (name === "SetextHeading1" || name === "SetextHeading2") {
      const level = name === "SetextHeading1" ? 1 : 2;
      const underlineStart = lineStart(doc, node.to > node.from ? node.to - 1 : node.to);
      for (let pos = lineStart(doc, node.from); pos < underlineStart; ) {
        specs.push({ kind: "lineClass", pos, class: `cm-lp-h${level}` });
        const nl = doc.indexOf("\n", pos);
        if (nl === -1) break;
        pos = nl + 1;
      }
      specs.push({ kind: "lineClass", pos: underlineStart, class: "cm-lp-setext-underline" });
      return true;
    }

    // ---- Emphasis / strong / strikethrough --------------------------------
    if (name === "Emphasis" || name === "StrongEmphasis" || name === "Strikethrough") {
      const cls = name === "Emphasis" ? "cm-lp-em" : name === "StrongEmphasis" ? "cm-lp-strong" : "cm-lp-strike";
      specs.push({ kind: "mark", from: node.from, to: node.to, class: cls });
      if (!touches(selection, node.from, node.to)) {
        const markName = name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark";
        const marks = node.node.getChildren(markName);
        for (const mk of marks) specs.push({ kind: "hide", from: mk.from, to: mk.to });
      }
      return true;
    }

    // ---- Inline code --------------------------------------------------
    if (name === "InlineCode") {
      codeRanges.push({ from: node.from, to: node.to });
      specs.push({ kind: "mark", from: node.from, to: node.to, class: "cm-lp-code" });
      if (!touches(selection, node.from, node.to)) {
        for (const mk of node.node.getChildren("CodeMark")) {
          specs.push({ kind: "hide", from: mk.from, to: mk.to });
        }
      }
      return true;
    }

    // ---- Fenced code blocks --------------------------------------------
    if (name === "FencedCode") {
      codeRanges.push({ from: node.from, to: node.to });
      for (let pos = lineStart(doc, node.from); pos <= node.to; ) {
        specs.push({ kind: "lineClass", pos, class: "cm-lp-codeblock" });
        const nl = doc.indexOf("\n", pos);
        if (nl === -1 || nl >= node.to) break;
        pos = nl + 1;
      }
      if (!touches(selection, node.from, node.to)) {
        for (const mk of node.node.getChildren("CodeMark")) {
          specs.push({ kind: "dim", from: mk.from, to: mk.to });
        }
        const info = node.node.getChild("CodeInfo");
        if (info) specs.push({ kind: "dim", from: info.from, to: info.to });
      }
      return true;
    }

    // ---- Links -----------------------------------------------------------
    if (name === "Link") {
      const marks = node.node.getChildren("LinkMark");
      const urlNode = node.node.getChild("URL");
      specs.push({
        kind: "mark",
        from: node.from,
        to: node.to,
        class: "cm-lp-link",
        attrs: urlNode ? { "data-lp-url": doc.slice(urlNode.from, urlNode.to) } : undefined,
      });
      if (!touches(selection, node.from, node.to)) {
        for (const mk of marks) specs.push({ kind: "hide", from: mk.from, to: mk.to });
        if (urlNode) specs.push({ kind: "hide", from: urlNode.from, to: urlNode.to });
        const title = node.node.getChild("LinkTitle");
        if (title) specs.push({ kind: "hide", from: title.from, to: title.to });
      }
      return true;
    }

    // ---- Blockquote --------------------------------------------------
    if (name === "Blockquote") {
      for (let pos = lineStart(doc, node.from); pos <= node.to; ) {
        specs.push({ kind: "lineClass", pos, class: "cm-lp-blockquote" });
        const nl = doc.indexOf("\n", pos);
        if (nl === -1 || nl >= node.to) break;
        pos = nl + 1;
      }
      if (!touches(selection, node.from, node.to)) {
        for (const mk of node.node.getChildren("QuoteMark")) {
          let end = mk.to;
          if (doc[end] === " ") end++;
          specs.push({ kind: "hide", from: mk.from, to: end });
        }
      }
      return true;
    }

    // ---- Horizontal rule -----------------------------------------------
    if (name === "HorizontalRule") {
      if (!touches(selection, node.from, node.to)) {
        specs.push({ kind: "hr", from: node.from, to: node.to });
      }
      return true;
    }

    // ---- Lists -----------------------------------------------------------
    if (name === "ListItem") {
      const parent = node.node.parent;
      const isOrdered = parent?.name === "OrderedList";
      const listMark = node.node.getChild("ListMark");
      const task = node.node.getChild("Task");

      if (task) {
        const marker = task.getChild("TaskMarker");
        if (listMark) specs.push({ kind: "hide", from: listMark.from, to: listMark.to + 1 });
        if (marker) {
          const raw = doc.slice(marker.from, marker.to);
          const checked = /x/i.test(raw);
          specs.push({ kind: "checkbox", from: marker.from, to: marker.to, checked });
          if (checked) {
            // Task's own range covers the marker *and* the rest of the item
            // text (there's no separate "content" child), so strike just
            // the text after the marker (+ its single trailing space).
            let textFrom = marker.to;
            if (doc[textFrom] === " ") textFrom++;
            if (textFrom < node.to) {
              specs.push({ kind: "mark", from: textFrom, to: node.to, class: "cm-lp-task-done" });
            }
          }
        }
      } else if (listMark) {
        if (isOrdered) {
          specs.push({ kind: "mark", from: listMark.from, to: listMark.to, class: "cm-lp-ol-marker" });
        } else {
          specs.push({ kind: "bullet", from: listMark.from, to: listMark.to });
        }
      }
      return true;
    }

    return true;
  });

  // ---- Wikilinks (not part of the CommonMark/GFM grammar) -----------------
  for (const range of collectWikilinks(doc, codeRanges)) {
    const inner = doc.slice(range.from + 2, range.to - 2);
    const pipeIdx = inner.indexOf("|");
    const target = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
    const resolvedId = options.resolveWikilink?.(target);
    const missing = !!options.resolveWikilink && !resolvedId;
    specs.push({
      kind: "mark",
      from: range.from,
      to: range.to,
      class: missing ? "cm-lp-wikilink cm-lp-wikilink-missing" : "cm-lp-wikilink",
      attrs: {
        "data-lp-wikilink-target": target,
        ...(resolvedId ? { "data-lp-wikilink-id": resolvedId } : {}),
      },
    });
    if (!touches(selection, range.from, range.to)) {
      if (pipeIdx === -1) {
        specs.push({ kind: "hide", from: range.from, to: range.from + 2 });
        specs.push({ kind: "hide", from: range.to - 2, to: range.to });
      } else {
        specs.push({ kind: "hide", from: range.from, to: range.from + 2 + pipeIdx + 1 });
        specs.push({ kind: "hide", from: range.to - 2, to: range.to });
      }
    }
  }

  return specs;
}

// ---------------------------------------------------------------------------
// CodeMirror adapter
// ---------------------------------------------------------------------------

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }
}

class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-hr";
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-checkbox";
    box.checked = this.checked;
    box.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const replacement = this.checked ? " " : "x";
      view.dispatch({
        changes: { from: this.from + 1, to: this.to - 1, insert: replacement },
      });
    };
    return box;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function specsToDecorations(specs: LivePreviewSpec[], visible: readonly TextRange[]): DecorationSet {
  const inView = (from: number, to: number) => visible.some((r) => r.from <= to && r.to >= from);

  const points: { from: number; to: number; deco: Decoration }[] = [];
  for (const spec of specs) {
    switch (spec.kind) {
      case "hide":
        if (inView(spec.from, spec.to) && spec.from < spec.to) {
          points.push({ from: spec.from, to: spec.to, deco: Decoration.replace({}) });
        }
        break;
      case "dim":
        if (inView(spec.from, spec.to) && spec.from < spec.to) {
          points.push({ from: spec.from, to: spec.to, deco: Decoration.mark({ class: "cm-lp-dim" }) });
        }
        break;
      case "mark":
        if (inView(spec.from, spec.to) && spec.from < spec.to) {
          points.push({
            from: spec.from,
            to: spec.to,
            deco: Decoration.mark({ class: spec.class, attributes: spec.attrs }),
          });
        }
        break;
      case "lineClass":
        if (inView(spec.pos, spec.pos)) {
          points.push({ from: spec.pos, to: spec.pos, deco: Decoration.line({ class: spec.class }) });
        }
        break;
      case "bullet":
        if (inView(spec.from, spec.to)) {
          points.push({
            from: spec.from,
            to: spec.to,
            deco: Decoration.replace({ widget: new BulletWidget() }),
          });
        }
        break;
      case "checkbox":
        if (inView(spec.from, spec.to)) {
          points.push({
            from: spec.from,
            to: spec.to,
            deco: Decoration.replace({ widget: new CheckboxWidget(spec.checked, spec.from, spec.to) }),
          });
        }
        break;
      case "hr":
        if (inView(spec.from, spec.to)) {
          points.push({
            from: spec.from,
            to: spec.to,
            deco: Decoration.replace({ widget: new HrWidget() }),
          });
        }
        break;
    }
  }

  points.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const p of points) builder.add(p.from, p.to, p.deco);
  return builder.finish();
}

export interface LivePreviewOptions {
  /** Resolve a wikilink target to a document id, or undefined if missing. */
  resolveWikilink?: (target: string) => string | undefined;
  /** Cmd/Ctrl-click (or Mod-Enter) on a resolved wikilink. */
  onOpenWikilink?: (documentId: string) => void;
  /** Cmd/Ctrl-click (or Mod-Enter) on an unresolved wikilink. */
  onCreateWikilink?: (target: string) => void;
}

function buildDecorations(view: EditorView, options: LivePreviewOptions): DecorationSet {
  const doc = view.state.doc.toString();
  const selection = view.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const specs = computeLivePreviewSpecs(doc, selection, { resolveWikilink: options.resolveWikilink });
  return specsToDecorations(specs, view.visibleRanges);
}

function activateWikilinkAt(view: EditorView, pos: number, options: LivePreviewOptions): boolean {
  const doc = view.state.doc.toString();
  const hit = findWikilinkAt(doc, pos);
  if (!hit) return false;
  const resolved = options.resolveWikilink?.(hit.target);
  if (resolved) {
    options.onOpenWikilink?.(resolved);
    return true;
  }
  if (options.resolveWikilink) {
    options.onCreateWikilink?.(hit.target);
    return true;
  }
  return false;
}

function makeLivePreviewPlugin(options: LivePreviewOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, options);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view, options);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          if (!(event.metaKey || event.ctrlKey)) return;
          const target = event.target as HTMLElement | null;

          const wikilink = target?.closest<HTMLElement>(".cm-lp-wikilink");
          if (wikilink) {
            const pos = view.posAtDOM(wikilink);
            if (activateWikilinkAt(view, pos, options)) {
              event.preventDefault();
            }
            return;
          }

          const link = target?.closest<HTMLElement>("[data-lp-url]");
          const url = link?.getAttribute("data-lp-url");
          if (!url) return;
          event.preventDefault();
          window.open(url, "_blank", "noopener,noreferrer");
        },
      },
    },
  );
}

const livePreviewTheme = EditorView.baseTheme({
  // `@codemirror/language`'s defaultHighlightStyle bolds+underlines every
  // node tagged `heading` (which is also how the frontmatter block gets
  // mis-styled, since it currently parses as a setext heading). Our own
  // line classes below set the real Notion-like heading look; strip the
  // generic highlighter's underline/bold with higher specificity so it
  // doesn't show through on the marker/content spans it painted.
  ".cm-lp-h1, .cm-lp-h1 span, .cm-lp-h2, .cm-lp-h2 span, .cm-lp-h3, .cm-lp-h3 span, .cm-lp-h4, .cm-lp-h4 span, .cm-lp-h5, .cm-lp-h5 span, .cm-lp-h6, .cm-lp-h6 span":
    { textDecoration: "none", fontWeight: "600" },
  ".cm-lp-h1, .cm-lp-h1 span": { fontSize: "1.875rem", lineHeight: "1.3" },
  ".cm-lp-h2, .cm-lp-h2 span": { fontSize: "1.5rem", lineHeight: "1.3" },
  ".cm-lp-h3, .cm-lp-h3 span": { fontSize: "1.25rem", lineHeight: "1.35" },
  ".cm-lp-h4, .cm-lp-h4 span": { fontSize: "1.125rem", lineHeight: "1.4" },
  ".cm-lp-h5, .cm-lp-h5 span": { fontSize: "1rem", lineHeight: "1.4" },
  ".cm-lp-h6, .cm-lp-h6 span": { fontSize: "0.9rem", color: "var(--muted-foreground)" },
  ".cm-lp-setext-underline": { color: "var(--muted-foreground)", opacity: "0.6" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-strike": { textDecoration: "line-through", color: "var(--muted-foreground)" },
  ".cm-lp-code": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    backgroundColor: "var(--muted)",
    borderRadius: "4px",
    padding: "0.05em 0.3em",
  },
  ".cm-lp-codeblock": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    backgroundColor: "var(--muted)",
  },
  ".cm-lp-dim": { opacity: "0.45" },
  ".cm-lp-link": { color: "var(--primary)", textDecoration: "underline", cursor: "pointer" },
  ".cm-lp-wikilink": { color: "var(--primary)", textDecoration: "underline", cursor: "pointer" },
  ".cm-lp-wikilink-missing": {
    color: "var(--muted-foreground)",
    textDecoration: "underline dashed",
  },
  ".cm-lp-blockquote": {
    borderLeft: "3px solid var(--border)",
    paddingLeft: "0.75em",
    color: "var(--muted-foreground)",
  },
  ".cm-lp-frontmatter, .cm-lp-frontmatter span": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    color: "var(--muted-foreground)",
    fontSize: "0.85em",
    fontWeight: "400",
    fontStyle: "normal",
    textDecoration: "none",
  },
  ".cm-lp-ol-marker": { color: "var(--muted-foreground)" },
  ".cm-lp-task-done": { textDecoration: "line-through", color: "var(--muted-foreground)" },
  ".cm-lp-bullet": {
    display: "inline-block",
    width: "1em",
    color: "var(--muted-foreground)",
  },
  ".cm-lp-checkbox": {
    verticalAlign: "middle",
    marginRight: "0.4em",
    cursor: "pointer",
  },
  ".cm-lp-hr": {
    display: "block",
    height: "1px",
    backgroundColor: "var(--border)",
    margin: "0.5em 0",
  },
});

export function livePreview(options: LivePreviewOptions = {}): Extension {
  return [
    makeLivePreviewPlugin(options),
    livePreviewTheme,
    keymap.of([
      {
        key: "Mod-Enter",
        run: (view) => activateWikilinkAt(view, view.state.selection.main.head, options),
      },
    ]),
  ];
}
