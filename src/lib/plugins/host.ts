import { Plugin, bindPluginContext, API_VERSION, type App, type PluginContext, type PluginManifest } from "@/lib/plugins/api";
import type { PluginStorage } from "@/lib/plugins/storage";
import { CommandRegistry } from "@/lib/plugins/commands";
import { EditorExtensionRegistry } from "@/lib/plugins/editor";

export type PluginState = "disabled" | "enabled" | "failed";

export interface PluginStatus {
  manifest: PluginManifest;
  state: PluginState;
  error?: string;
}

interface Registration {
  manifest: PluginManifest;
  PluginClass: new (app: App, manifest: PluginManifest) => Plugin;
  instance: Plugin | null;
  disposers: (() => void)[];
  state: PluginState;
  error?: string;
}

const PLUGINS_JSON_PATH = ".adhd/plugins.json";

function pluginDataPath(id: string): string {
  return `.adhd/plugins/${id}/data.json`;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export class PluginHost {
  private registrations = new Map<string, Registration>();
  private listeners = new Set<() => void>();
  /** Set by `dispose()`. A disposed host still has in-flight `enable()`
   *  calls that started before disposal roll back instead of committing
   *  (see `enable()`), so a caller replacing this host with a fresh one
   *  sharing the same `CommandRegistry`/`EditorExtensionRegistry` never
   *  races a duplicate registration against the orphaned in-flight call. */
  private disposed = false;

  readonly editorExtensions: EditorExtensionRegistry;

  constructor(
    private app: App,
    private storage: PluginStorage,
    private commands: CommandRegistry = new CommandRegistry(),
    editorExtensions: EditorExtensionRegistry = new EditorExtensionRegistry(),
  ) {
    this.editorExtensions = editorExtensions;
  }

  register(manifest: PluginManifest, PluginClass: new (app: App, manifest: PluginManifest) => Plugin): void {
    this.registrations.set(manifest.id, {
      manifest,
      PluginClass,
      instance: null,
      disposers: [],
      state: "disabled",
    });
  }

  async enable(id: string): Promise<void> {
    if (this.disposed) return;
    const reg = this.registrations.get(id);
    if (!reg) throw new Error(`Unknown plugin: ${id}`);

    if (compareVersions(reg.manifest.minAppVersion, API_VERSION) > 0) {
      reg.state = "failed";
      reg.error = `minAppVersion ${reg.manifest.minAppVersion} exceeds API_VERSION ${API_VERSION}`;
      this.emit();
      return;
    }

    const disposers: (() => void)[] = [];
    const instance = new reg.PluginClass(this.app, reg.manifest);
    // Task 2 wires only `register`/`loadData`/`saveData` for real; `addCommand`
    // and `registerEditorExtension`/`registerCompletionSource` are still
    // no-ops here (no CommandRegistry/EditorExtensionRegistry exists yet at
    // this point in the plan) — Task 9 and Task 10 replace this `ctx` object
    // wholesale once those registries exist, still via `bindPluginContext`,
    // never by patching properties onto `instance`.
    const ctx: PluginContext = {
      addCommand: (cmd) => {
        disposers.push(this.commands.add(reg.manifest.id, cmd));
        return cmd;
      },
      registerEditorExtension: (ext) => {
        disposers.push(this.editorExtensions.addExtension(reg.manifest.id, ext));
      },
      registerCompletionSource: (source) => {
        disposers.push(this.editorExtensions.addCompletionSource(reg.manifest.id, source));
      },
      register: (dispose: () => void) => {
        disposers.push(dispose);
      },
      loadData: async <T,>(): Promise<T | null> => {
        const bytes = await this.storage.read(pluginDataPath(reg.manifest.id));
        if (!bytes) return null;
        try {
          const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { data: T };
          return parsed.data;
        } catch {
          return null;
        }
      },
      saveData: async (data: unknown): Promise<void> => {
        const bytes = new TextEncoder().encode(JSON.stringify({ data }));
        await this.storage.write(pluginDataPath(reg.manifest.id), bytes);
      },
    };
    bindPluginContext(instance, ctx);

    try {
      await instance.onload();
      if (this.disposed) {
        // This host was torn down while onload() was in flight (e.g. a
        // React effect cleanup racing a still-resolving enable() during
        // StrictMode's double-invoke). The registrations this call already
        // pushed to the shared CommandRegistry/EditorExtensionRegistry are
        // real and must be rolled back — nothing else will, since `reg`
        // never got a chance to record them — but this was never a real
        // state change, so it must not be persisted.
        for (const dispose of [...disposers].reverse()) dispose();
        return;
      }
      reg.instance = instance;
      reg.disposers = disposers;
      reg.state = "enabled";
      reg.error = undefined;
    } catch (err) {
      for (const dispose of [...disposers].reverse()) dispose();
      reg.instance = null;
      reg.disposers = [];
      reg.state = "failed";
      reg.error = err instanceof Error ? err.message : String(err);
      console.error(`[plugins] ${reg.manifest.id} failed to load:`, err);
    }

    await this.persistEnabled();
    this.emit();
  }

  async disable(id: string): Promise<void> {
    const reg = this.registrations.get(id);
    if (!reg) throw new Error(`Unknown plugin: ${id}`);
    if (reg.instance) {
      reg.instance.onunload();
      for (const dispose of [...reg.disposers].reverse()) dispose();
    }
    reg.instance = null;
    reg.disposers = [];
    reg.state = "disabled";
    reg.error = undefined;
    await this.persistEnabled();
    this.emit();
  }

  /** Enable every plugin listed in `.adhd/plugins.json`, or every `isCore`
   *  plugin when the file is absent (spec §1). Call once at boot. */
  async enableFromStorage(): Promise<void> {
    const bytes = await this.storage.read(PLUGINS_JSON_PATH);
    let enabledIds: string[];
    if (!bytes) {
      enabledIds = [...this.registrations.values()].filter((r) => r.manifest.isCore).map((r) => r.manifest.id);
    } else {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { enabled: string[] };
        enabledIds = parsed.enabled ?? [];
      } catch {
        enabledIds = [...this.registrations.values()].filter((r) => r.manifest.isCore).map((r) => r.manifest.id);
      }
    }
    for (const id of enabledIds) {
      if (this.disposed) return;
      if (this.registrations.has(id)) await this.enable(id);
    }
  }

  /**
   * Tear this host down synchronously: unload every currently-enabled
   * plugin (running `onunload`/disposers, same as `disable()`) and mark the
   * host so any `enable()` call already in flight rolls back instead of
   * committing. Unlike `disable()`, this never writes to storage — it's
   * meant for a caller (e.g. a React effect cleanup) discarding this host
   * in favour of a new one, not a user-facing state change, and the
   * storage already holds the correct persisted set from before this host
   * existed.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const reg of this.registrations.values()) {
      if (!reg.instance) continue;
      reg.instance.onunload();
      for (const dispose of [...reg.disposers].reverse()) dispose();
      reg.instance = null;
      reg.disposers = [];
      reg.state = "disabled";
      reg.error = undefined;
    }
    this.emit();
  }

  list(): PluginStatus[] {
    return [...this.registrations.values()].map((r) => ({ manifest: r.manifest, state: r.state, error: r.error }));
  }

  getPlugin(id: string): Plugin | undefined {
    return this.registrations.get(id)?.instance ?? undefined;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getSnapshot(): PluginStatus[] {
    return this.list();
  }

  private async persistEnabled(): Promise<void> {
    const enabled = [...this.registrations.values()].filter((r) => r.state === "enabled").map((r) => r.manifest.id);
    await this.storage.write(PLUGINS_JSON_PATH, new TextEncoder().encode(JSON.stringify({ enabled })));
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}
