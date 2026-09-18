import { describe, expect, it, vi } from "vitest";
import { countWords, WORD_COUNT_MANIFEST, WordCountPlugin } from "@/plugins/word-count";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { HotkeyManager } from "@/lib/plugins/hotkeys";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import type { App } from "@/lib/plugins/api";
import type { EditorView } from "@codemirror/view";

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

function makeApp(notify: App["notify"] = () => {}): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: { getActiveNote: () => null, openNote: () => {}, toggleSidebar: () => {}, openDialog: () => {} },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify,
  };
}

const fakeEditorView = (text: string) => ({ state: { doc: { toString: () => text } } }) as unknown as EditorView;

describe("WordCountPlugin (Task A2: editorCallback + hotkey)", () => {
  it("registers Word count: Show as an editorCallback command, hidden with no active note", async () => {
    const notify = vi.fn();
    const app = makeApp(notify);
    const commands = new CommandRegistry();
    const host = new PluginHost(app, new InMemoryPluginStorage(), commands);
    host.register(WORD_COUNT_MANIFEST, WordCountPlugin);
    await host.enable("word-count");

    expect(commands.list(null)).toEqual([]);
    const [cmd] = commands.list({ documentId: "d1", isGraph: false });
    expect(cmd.fullId).toBe("word-count:show-word-count");
  });

  it("counts the passed editor's doc, not a cached value from a different view", async () => {
    const notify = vi.fn();
    const app = makeApp(notify);
    const commands = new CommandRegistry();
    const host = new PluginHost(app, new InMemoryPluginStorage(), commands);
    host.register(WORD_COUNT_MANIFEST, WordCountPlugin);
    await host.enable("word-count");

    const note = { documentId: "d1", isGraph: false };
    await commands.execute("word-count:show-word-count", note, fakeEditorView("one two three"), notify);
    expect(notify).toHaveBeenCalledWith("3 words", "info");

    notify.mockClear();
    await commands.execute("word-count:show-word-count", note, fakeEditorView("solo"), notify);
    expect(notify).toHaveBeenCalledWith("1 word", "info");
  });

  it("no-ops (does nothing) when run with no active editor view", async () => {
    const notify = vi.fn();
    const app = makeApp(notify);
    const commands = new CommandRegistry();
    const host = new PluginHost(app, new InMemoryPluginStorage(), commands);
    host.register(WORD_COUNT_MANIFEST, WordCountPlugin);
    await host.enable("word-count");

    const note = { documentId: "d1", isGraph: false };
    await commands.execute("word-count:show-word-count", note, null, notify);
    expect(notify).not.toHaveBeenCalled();
  });

  it("registers a default Mod+Alt+W hotkey (Mod+Shift+W is reserved by the browser)", async () => {
    const app = makeApp();
    const commands = new CommandRegistry();
    const storage = new InMemoryPluginStorage();
    const hotkeys = new HotkeyManager(storage);
    const host = new PluginHost(app, storage, commands, undefined, hotkeys);
    host.register(WORD_COUNT_MANIFEST, WordCountPlugin);
    await host.enable("word-count");

    expect(hotkeys.getEffective("word-count:show-word-count")).toEqual([{ modifiers: ["Mod", "Alt"], key: "w" }]);
  });
});
