// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  builtInSlashCommands,
  filterSlashCommands,
  insertBlock,
  matchSlashPrefix,
} from "@/lib/editor/slash-menu";
import { EditorExtensionRegistry } from "@/lib/plugins/editor";

describe("matchSlashPrefix", () => {
  it("matches / at the start of a line or after a space", () => {
    expect(matchSlashPrefix("/h", 2)).toEqual({ from: 0, query: "h" });
    expect(matchSlashPrefix("text /tab", 9)).toEqual({ from: 5, query: "tab" });
    expect(matchSlashPrefix("  /", 3)).toEqual({ from: 2, query: "" });
  });

  it("ignores / inside a word or a path", () => {
    expect(matchSlashPrefix("and/or", 6)).toBeUndefined();
    expect(matchSlashPrefix("https://x", 9)).toBeUndefined();
    expect(matchSlashPrefix("/a b", 4)).toBeUndefined();
  });
});

describe("filterSlashCommands", () => {
  const commands = builtInSlashCommands(() => new Date(2026, 8, 24));
  it("finds by label or keyword, prefix matches first", () => {
    expect(filterSlashCommands(commands, "h1").map((c) => c.id)).toEqual(["h1"]);
    expect(filterSlashCommands(commands, "list").map((c) => c.id)).toEqual(["bullet", "numbered", "task"]);
    expect(filterSlashCommands(commands, "").length).toBe(commands.length);
  });
});

describe("insertBlock", () => {
  function run(doc: string, from: number, to: number, apply: ReturnType<typeof insertBlock>) {
    const view = new EditorView({ state: EditorState.create({ doc }) });
    apply(view, from, to);
    const result = { text: view.state.doc.toString(), cursor: view.state.selection.main.head };
    view.destroy();
    return result;
  }

  it("replaces the typed /query and puts the cursor between before and after", () => {
    expect(run("/code", 0, 5, insertBlock("```\n", "\n```"))).toEqual({ text: "```\n\n```", cursor: 4 });
    expect(run("a /h1", 2, 5, insertBlock("# "))).toEqual({ text: "a # ", cursor: 4 });
  });

  it("builds a table with the cursor in the first cell", () => {
    const table = builtInSlashCommands().find((c) => c.id === "table")!;
    const view = new EditorView({ state: EditorState.create({ doc: "/table" }) });
    table.apply(view, 0, 6);
    expect(view.state.doc.toString()).toBe("|  |  |\n| --- | --- |\n|  |  |");
    expect(view.state.selection.main.head).toBe(2);
    view.destroy();
  });
});

describe("EditorExtensionRegistry slash commands", () => {
  it("lists the built-ins, then plugin entries and providers, and drops them on dispose", () => {
    const registry = new EditorExtensionRegistry();
    const builtIns = registry.slashCommands().length;
    const off = registry.addSlashCommand("p", { id: "hello", label: "Hello", apply: insertBlock("hi") });
    registry.addSlashCommand("q", () => [{ id: "tmpl-1", label: "Template: One", apply: insertBlock("one") }]);
    registry.addSlashCommand("bad", () => {
      throw new Error("broken provider");
    });
    const ids = registry.slashCommands().map((c) => c.id);
    expect(ids.length).toBe(builtIns + 2);
    expect(ids.slice(-2)).toEqual(["hello", "tmpl-1"]);
    off();
    expect(registry.slashCommands().map((c) => c.id)).not.toContain("hello");
  });
});
