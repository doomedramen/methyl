import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

/**
 * The `/` menu (spec item 18): typing `/` at the start of a line or after a
 * space lists blocks to insert. Plugins add entries with
 * `registerSlashCommand` (see src/lib/plugins/api.ts). Matching and the
 * built-in entries are plain functions, tested without an editor;
 * `slashCompletionSource` is the thin CodeMirror adapter, like the wikilink
 * completion's.
 */

export interface SlashCommand {
  /** Unique within the menu. */
  id: string;
  label: string;
  /** Extra words that find it (`h1` finds "Heading 1"). */
  keywords?: string[];
  detail?: string;
  /** Replace `from`..`to` (the `/query` typed) with the block. */
  apply(view: EditorView, from: number, to: number): void;
}

/** A command, or a function listing commands when the menu opens (e.g. templates). */
export type SlashSource = SlashCommand | (() => SlashCommand[]);

/**
 * Replace the typed `/query` with `before` + `after`, leaving the cursor
 * between them (e.g. inside a code fence).
 */
export function insertBlock(before: string, after = ""): SlashCommand["apply"] {
  return (view, from, to) => {
    view.dispatch({
      changes: { from, to, insert: before + after },
      selection: { anchor: from + before.length },
      userEvent: "input.complete",
      scrollIntoView: true,
    });
  };
}

/** `/query` right before the cursor, at the start of the line or after whitespace. */
export function matchSlashPrefix(text: string, cursor: number): { from: number; query: string } | undefined {
  const match = /(^|\s)\/([\w-]*)$/.exec(text.slice(0, cursor));
  if (!match) return undefined;
  return { from: match.index + match[1]!.length, query: match[2]! };
}

/** Commands whose label or keywords contain `query`, label-prefix matches first, then in order. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const words = (c: SlashCommand) => [c.label, ...(c.keywords ?? [])].map((w) => w.toLowerCase());
  const hits = commands.filter((c) => words(c).some((w) => w.includes(q)));
  const rank = (c: SlashCommand) => (words(c).some((w) => w.startsWith(q)) ? 0 : 1);
  return hits
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

export function slashCompletionSource(getCommands: () => SlashCommand[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const hit = matchSlashPrefix(line.text, context.pos - line.from);
    if (!hit) return null;
    const from = line.from + hit.from;
    const commands = filterSlashCommands(getCommands(), hit.query);
    if (commands.length === 0) return null;
    return {
      from,
      to: context.pos,
      filter: false,
      options: commands.map((command) => ({
        label: command.label,
        detail: command.detail,
        type: "keyword",
        apply: (view, _completion, applyFrom, applyTo) => command.apply(view, applyFrom, applyTo),
      })),
    };
  };
}

function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The menu's own entries. */
export function builtInSlashCommands(now: () => Date = () => new Date()): SlashCommand[] {
  return [
    { id: "h1", label: "Heading 1", keywords: ["h1", "title"], apply: insertBlock("# ") },
    { id: "h2", label: "Heading 2", keywords: ["h2", "subtitle"], apply: insertBlock("## ") },
    { id: "h3", label: "Heading 3", keywords: ["h3"], apply: insertBlock("### ") },
    { id: "bullet", label: "Bulleted list", keywords: ["ul", "bullet", "list"], apply: insertBlock("- ") },
    { id: "numbered", label: "Numbered list", keywords: ["ol", "number", "list"], apply: insertBlock("1. ") },
    { id: "task", label: "Task list", keywords: ["todo", "checkbox", "task"], apply: insertBlock("- [ ] ") },
    {
      id: "table",
      label: "Table",
      keywords: ["grid"],
      apply: insertBlock("| ", " |  |\n| --- | --- |\n|  |  |"),
    },
    { id: "code", label: "Code block", keywords: ["code", "fence", "pre"], apply: insertBlock("```\n", "\n```") },
    { id: "quote", label: "Quote", keywords: ["blockquote", "cite"], apply: insertBlock("> ") },
    { id: "divider", label: "Divider", keywords: ["hr", "rule", "line"], apply: insertBlock("---\n") },
    {
      id: "date",
      label: "Today's date",
      keywords: ["date", "today", "now"],
      detail: todayIso(now()),
      apply: (view, from, to) => insertBlock(todayIso(now()))(view, from, to),
    },
  ];
}
