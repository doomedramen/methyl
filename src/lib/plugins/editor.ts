import { type Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
import {
  builtInSlashCommands,
  slashCompletionSource,
  type SlashCommand,
  type SlashSource,
} from "@/lib/editor/slash-menu";

/** Guard a single completion source so a throw never breaks the others.
 *  CodeMirror's `autocompletion({ override })` takes an *array* of sources
 *  and merges every non-null result itself — Phase 1 must not pre-merge or
 *  pick a winner; it only makes each source safe to call. */
export function wrapCompletionSource(source: CompletionSource): CompletionSource {
  return (context) => {
    try {
      return source(context);
    } catch (err) {
      console.error("[plugins] completion source threw:", err);
      return null;
    }
  };
}

interface ExtensionEntry {
  pluginId: string;
  ext: Extension | Extension[];
}

interface CompletionEntry {
  pluginId: string;
  source: CompletionSource;
}

interface SlashEntry {
  pluginId: string;
  source: SlashSource;
}

export class EditorExtensionRegistry {
  private extensions: ExtensionEntry[] = [];
  private completions: CompletionEntry[] = [];
  private slash: SlashEntry[] = [];
  private listeners = new Set<() => void>();

  addExtension(pluginId: string, ext: Extension | Extension[]): () => void {
    const entry: ExtensionEntry = { pluginId, ext };
    this.extensions.push(entry);
    this.emit();
    return () => {
      this.extensions = this.extensions.filter((e) => e !== entry);
      this.emit();
    };
  }

  addCompletionSource(pluginId: string, source: CompletionSource): () => void {
    const entry: CompletionEntry = { pluginId, source };
    this.completions.push(entry);
    this.emit();
    return () => {
      this.completions = this.completions.filter((e) => e !== entry);
      this.emit();
    };
  }

  /** Add a `/` menu entry, or a function listing entries (spec item 18). */
  addSlashCommand(pluginId: string, source: SlashSource): () => void {
    const entry: SlashEntry = { pluginId, source };
    this.slash.push(entry);
    this.emit();
    return () => {
      this.slash = this.slash.filter((e) => e !== entry);
      this.emit();
    };
  }

  /**
   * Every `/` menu entry now: the built-in blocks, then plugins' entries in
   * registration order. The built-ins aren't a plugin, so the menu works in
   * vaults whose plugin list predates it. A failing provider is skipped.
   */
  slashCommands(): SlashCommand[] {
    const out: SlashCommand[] = [];
    const seen = new Set<string>();
    for (const { source } of [{ source: builtInSlashCommands }, ...this.slash]) {
      let commands: SlashCommand[];
      try {
        commands = typeof source === "function" ? source() : [source];
      } catch (err) {
        console.error("[plugins] slash command provider threw:", err);
        continue;
      }
      for (const command of commands) {
        if (seen.has(command.id)) continue;
        seen.add(command.id);
        out.push(command);
      }
    }
    return out;
  }

  buildExtension(): Extension {
    const sources = this.completions.map((c) => wrapCompletionSource(c.source));
    // The `/` menu reads the registry live, so entries added later show up.
    sources.push(wrapCompletionSource(slashCompletionSource(() => this.slashCommands())));
    return [
      ...this.extensions.map((e) => e.ext),
      autocompletion({ override: sources }),
    ];
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getSnapshot(): { pluginId: string }[] {
    return this.extensions.map((e) => ({ pluginId: e.pluginId }));
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}

/** Push a fresh set of plugin extensions into `view` without recreating it,
 *  preserving cursor/undo state (spec §3). */
export function reconfigurePluginCompartment(view: EditorView, compartment: Compartment, extension: Extension): void {
  view.dispatch({ effects: compartment.reconfigure(extension) });
}
