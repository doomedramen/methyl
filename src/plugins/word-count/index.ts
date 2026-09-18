import { EditorView } from "@codemirror/view";
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

const counts = new WeakMap<EditorView, number>();
let lastView: EditorView | null = null;

export class WordCountPlugin extends Plugin {
  private settings: WordCountSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    this.settings = (await this.loadData<WordCountSettings>()) ?? DEFAULT_SETTINGS;

    this.registerEditorExtension(
      EditorView.updateListener.of((update) => {
        lastView = update.view;
        if (update.docChanged || counts.get(update.view) === undefined) {
          counts.set(update.view, countWords(update.state.doc.toString(), this.settings));
        }
      }),
    );

    this.addCommand({
      id: "show-word-count",
      name: "Word count: Show",
      callback: () => {
        const count = lastView ? (counts.get(lastView) ?? 0) : 0;
        this.app.notify(`${count} word${count === 1 ? "" : "s"}`, "info");
      },
    });
  }
}
