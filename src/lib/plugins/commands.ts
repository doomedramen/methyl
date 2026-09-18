import type { Command, NoteContext } from "@/lib/plugins/api";
import type { EditorView } from "@codemirror/view";

export interface RegisteredCommand extends Command {
  fullId: string;
  pluginId: string;
}

export class CommandRegistry {
  private commands = new Map<string, RegisteredCommand>();
  private listeners = new Set<() => void>();

  add(pluginId: string, cmd: Command): () => void {
    const fullId = `${pluginId}:${cmd.id}`;
    if (this.commands.has(fullId)) {
      throw new Error(`Duplicate command id: ${fullId}`);
    }
    this.commands.set(fullId, { ...cmd, fullId, pluginId });
    this.emit();
    return () => {
      this.commands.delete(fullId);
      this.emit();
    };
  }

  list(activeNote: NoteContext | null): RegisteredCommand[] {
    return [...this.commands.values()].filter((cmd) => {
      if (cmd.checkCallback && cmd.checkCallback(true) === false) return false;
      if (cmd.editorCallback && !activeNote) return false;
      return true;
    });
  }

  async execute(
    fullId: string,
    activeNote: NoteContext | null,
    editorView: EditorView | null,
    notify: (msg: string, kind?: "info" | "success" | "error") => void,
  ): Promise<void> {
    const cmd = this.commands.get(fullId);
    if (!cmd) return;
    try {
      if (cmd.callback) {
        await cmd.callback();
      } else if (cmd.checkCallback) {
        cmd.checkCallback(false);
      } else if (cmd.editorCallback) {
        if (!editorView || !activeNote) return;
        cmd.editorCallback(editorView, activeNote);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(`"${cmd.name}" failed: ${message}`, "error");
    }
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getSnapshot(): RegisteredCommand[] {
    return [...this.commands.values()];
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}
