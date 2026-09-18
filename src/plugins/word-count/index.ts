import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";

export const WORD_COUNT_MANIFEST: PluginManifest = {
  id: "word-count",
  name: "Word Count",
  description: "Shows a word count for the active note.",
  version: "1.0.0",
  minAppVersion: API_VERSION,
};

export interface WordCountSettings {
  includeFrontmatter: boolean;
}

const DEFAULT_SETTINGS: WordCountSettings = { includeFrontmatter: false };

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return text;
}

export function countWords(text: string, settings: WordCountSettings): number {
  const body = settings.includeFrontmatter ? text : stripFrontmatter(text);
  const words = body.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export class WordCountPlugin extends Plugin {
  private settings: WordCountSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    this.settings = (await this.loadData<WordCountSettings>()) ?? DEFAULT_SETTINGS;

    this.addCommand({
      id: "show-word-count",
      name: "Word count: Show",
      // editorCallback (not callback): counts the *active* editor's doc, so
      // the command only shows up in ⌘K/the hotkey while a note is open
      // (CommandRegistry.list/execute hide/no-op editorCallback commands
      // without an active note — see src/lib/plugins/commands.ts) and it
      // always reflects the doc that's actually focused, not a cached value
      // from whichever view last fired an update.
      editorCallback: (editor) => {
        const count = countWords(editor.state.doc.toString(), this.settings);
        this.app.notify(`${count} word${count === 1 ? "" : "s"}`, "info");
      },
      // Mod+Shift+W is reserved by Chrome/Safari/Firefox on both macOS and
      // Windows (closes the window/all tabs) and never reaches page JS, so
      // the default here is Mod+Alt+W instead (plan:
      // docs/superpowers/plans/2026-09-18-plugins-roadmap.md, Task A2).
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "w" }],
    });
  }
}
