import { type Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";

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

export class EditorExtensionRegistry {
  private extensions: ExtensionEntry[] = [];
  private completions: CompletionEntry[] = [];
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

  buildExtension(): Extension {
    const sources = this.completions.map((c) => wrapCompletionSource(c.source));
    return [
      ...this.extensions.map((e) => e.ext),
      autocompletion({ override: sources.length > 0 ? sources : undefined }),
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
