import type { SlashSource } from "@/lib/editor/slash-menu";
import type { LucideIcon } from "lucide-react";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CompletionSource } from "@codemirror/autocomplete";
import type { WikilinkCandidate } from "@/lib/vault/wikilink";

// The `/` menu API for plugins (spec item 18).
export { insertBlock, type SlashCommand, type SlashSource } from "@/lib/editor/slash-menu";

export { type WikilinkCandidate };

export const API_VERSION = "1.0.0";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description?: string;
  author?: string;
  isCore?: boolean;
}

export interface Hotkey {
  modifiers: ("Mod" | "Ctrl" | "Alt" | "Shift" | "Meta")[];
  key: string;
}

export interface NoteContext {
  documentId: string;
  isGraph: boolean;
}

export interface NoteCreationOptions {
  name?: string;
  markdown?: string;
}

export interface Command {
  id: string;
  name: string;
  icon?: LucideIcon;
  keywords?: string[];
  hotkeys?: Hotkey[];
  callback?: () => void | Promise<void>;
  checkCallback?: (checking: boolean) => boolean;
  editorCallback?: (editor: EditorView, ctx: NoteContext) => void;
}

export interface App {
  commands: {
    list(): Command[];
    execute(fullId: string): void;
  };
  workspace: {
    getActiveNote(): NoteContext | null;
    openNote(id: string): void;
    toggleSidebar(): void;
    openDialog(name: string): void;
    resolveWikilink?(target: string): string | undefined;
    createWikilinkTarget?(target: string): void;
    getWikilinkCandidates?(): WikilinkCandidate[];
    /** Resolve an attachment embed to a cached browser object URL. */
    resolveAttachment?(target: string, documentId?: string): string | undefined;
    /** Load an attachment embed and return a browser object URL. */
    loadAttachment?(target: string, documentId?: string): Promise<string | undefined>;
    /**
     * The mounted CodeMirror view for the active note, if any. Internal
     * wiring detail (not part of the documented plugin surface): it's how
     * `app.commands.execute` reaches a live `EditorView` for `Command`s with
     * an `editorCallback`. `setActiveEditorView` is called by `NoteEditor`
     * on mount/unmount; plugins should treat both as implementation detail.
     */
    getActiveEditorView?(): EditorView | null;
    setActiveEditorView?(view: EditorView | null, workspaceTabId?: string): void;
    focusEditorTab?(workspaceTabId: string): void;
  };
  vault: {
    createNote(options?: NoteCreationOptions): Promise<string>;
    /** Capture a blank note in Inbox without changing generic note creation routing. */
    captureThought?(): Promise<string>;
    createGraph(): Promise<string>;
    createFolder(name: string): Promise<void>;
    read(id: string): Promise<string | null>;
    list(): NoteContext[];
  };
  notify(message: string, kind?: "info" | "success" | "error"): void;
}

/**
 * The real behaviour behind a bound plugin's registration methods.
 * `PluginHost` (see host.ts) constructs one of these per `enable()` call
 * and binds it to the plugin instance via `bindPluginContext` before
 * calling `onload()`. Never implemented by plugin code.
 */
export interface PluginContext {
  addCommand(cmd: Command): Command;
  registerEditorExtension(ext: Extension | Extension[]): void;
  registerCompletionSource(source: CompletionSource): void;
  registerSlashCommand(source: SlashSource): void;
  register(dispose: () => void): void;
  loadData<T>(): Promise<T | null>;
  saveData(data: unknown): Promise<void>;
}

const contexts = new WeakMap<Plugin, PluginContext>();

/**
 * @internal Used only by `PluginHost`. Associates `ctx` with `plugin` so
 * `plugin`'s registration methods delegate to it. Not part of the plugin
 * author surface — a plugin never calls this itself.
 */
export function bindPluginContext(plugin: Plugin, ctx: PluginContext): void {
  contexts.set(plugin, ctx);
}

/**
 * Base class bundled and community plugins subclass. Every registration
 * method delegates to the `PluginContext` bound via `bindPluginContext`;
 * with no context bound (e.g. a `Plugin` constructed directly in a unit
 * test) the methods fall back to inert defaults, so `Plugin` never depends
 * on `host.ts` and is safe to instantiate standalone.
 */
export abstract class Plugin {
  constructor(
    readonly app: App,
    readonly manifest: PluginManifest,
  ) {}

  onload(): void | Promise<void> {}
  onunload(): void {}

  addCommand(cmd: Command): Command {
    return contexts.get(this)?.addCommand(cmd) ?? cmd;
  }

  registerEditorExtension(ext: Extension | Extension[]): void {
    contexts.get(this)?.registerEditorExtension(ext);
  }

  registerCompletionSource(source: CompletionSource): void {
    contexts.get(this)?.registerCompletionSource(source);
  }

  /** Add an entry to the editor's `/` menu, or a function listing entries. */
  registerSlashCommand(source: SlashSource): void {
    contexts.get(this)?.registerSlashCommand(source);
  }

  register(dispose: () => void): void {
    contexts.get(this)?.register(dispose);
  }

  async loadData<T>(): Promise<T | null> {
    const ctx = contexts.get(this);
    return ctx ? await ctx.loadData<T>() : null;
  }

  async saveData(data: unknown): Promise<void> {
    await contexts.get(this)?.saveData(data);
  }
}
