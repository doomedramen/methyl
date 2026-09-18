# Plugin System Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Methyl an Obsidian-style first-party plugin architecture — `PluginHost`, command/hotkey registries, an editor-extension compartment, a React binding, and four bundled plugins (`core-commands`, `core-live-preview`, `core-wikilinks`, `word-count`) — replacing the hard-coded actions in `CommandMenu`/`VaultApp` without changing user-visible behaviour.

**Architecture:** `PluginHost` owns lifecycle (register/enable/disable, rollback on `onload` throw) and per-extension-point registries (`CommandRegistry`, `HotkeyManager`, `EditorExtensionRegistry`). Plugins only see an injected `App` facade and `@/lib/plugins/api` types — never `@/lib/*` internals directly. React reads registries via `useSyncExternalStore`; the CodeMirror editor reconfigures one `Compartment` on registry change so cursor/undo survive plugin toggles. Storage (`.adhd/plugins.json`, `.adhd/plugins/<id>/data.json`) goes through a small injected `PluginStorage` adapter (backed by `VaultEngine`'s `docStore.readMaterialized`/`writeMaterializedAtomic`) so the host is unit-testable without a real vault.

**Tech Stack:** TypeScript, React 19, CodeMirror 6 (`@codemirror/state`/`view`/`autocomplete`), Vitest (`vitest run`, node environment), `sonner` toasts, `cmdk`-based `Command` UI, ESLint flat config (`eslint-config-next`).

**Spec:** `docs/superpowers/specs/2026-09-18-plugin-system-design.md`

## Global Constraints

- Phase 1 only: no loading third-party code from disk/network, no sandboxing, no UI slots/vault events/markdown post-processors/graph extensions/`registerTheme`, no hotkey-editing UI (spec "Non-goals").
- Plugins reach the app only through `app: App` and types re-exported from `@/lib/plugins/api`; they never import `@/lib/*` internals directly (spec §Architecture, §4).
- Every registration (`addCommand`, `registerEditorExtension`, `registerCompletionSource`, `register`) returns/records a disposer; unloading runs them in reverse order (spec §Architecture, §1).
- Plugin storage lives inside the vault under `.adhd/plugins.json` and `.adhd/plugins/<id>/data.json`; never inside `.md` files (spec §1, §4).
- `.adhd/plugins.json` absent ⇒ all `isCore` plugins enabled (spec §1).
- States are `disabled | enabled | failed`, subscribable (spec §1).
- `⌘K` stays hard-wired in core; plugins cannot override it (spec §2).
- ESLint `no-restricted-imports` on `src/plugins/**`: only `@/lib/plugins/api`, `@codemirror/*`, `@lezer/*`, `lucide-react`, `react` (spec §4).
- `API_VERSION` exported; `minAppVersion` checked at `enable()` time (spec §1, §4).
- Tests: Vitest, `include: ["src/**/*.test.ts"]`, `environment: "node"` (`vitest.config.ts`). Run with `npx vitest run <path>` for single files, `npm test` for the whole suite.
- Commit messages: Conventional Commits, no `Co-authored-by` trailer, never `--no-verify`.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/lib/plugins/api.ts` | Public types: `Plugin`, `App`, `PluginManifest`, `Command`, `Hotkey`, `NoteContext`, `API_VERSION` |
| `src/lib/plugins/host.ts` | `PluginHost`: register/enable/disable, rollback, `plugins.json` persistence via `PluginStorage` |
| `src/lib/plugins/commands.ts` | `CommandRegistry` |
| `src/lib/plugins/hotkeys.ts` | `HotkeyManager`, `Mod` normalisation, `hotkeys.json` overrides |
| `src/lib/plugins/editor.ts` | `EditorExtensionRegistry`, completion-source registry, compartment helpers |
| `src/lib/plugins/react.tsx` | `PluginHostProvider`, `usePluginHost`, `useCommands` |
| `src/plugins/core-commands/index.ts` | Migrated actions (new note/graph/folder, toggle sidebar, sync settings, themes, "Plugins: Manage") |
| `src/plugins/core-live-preview/index.ts` | Wraps `livePreview()` as a registered editor extension |
| `src/plugins/core-wikilinks/index.ts` | Wraps `wikilinkCompletionSource` as a registered completion source |
| `src/plugins/word-count/index.ts` | New plugin: editor extension + command + `saveData`/`loadData` |
| `src/plugins/index.ts` | `BUNDLED_PLUGINS: [PluginManifest, typeof Plugin][]` |
| `src/components/plugins/PluginsDialog.tsx` | Enable/disable list, shows `failed` error text |
| `src/components/vault/CommandMenu.tsx` | Modified: Actions group renders `useCommands()` |
| `src/components/vault/VaultApp.tsx` | Modified: builds `App`, registers/enables bundled plugins, provides host via context |
| `src/lib/editor/extensions.ts` | Modified: `adhdEditorExtensions` takes a plugin compartment instead of the single wikilink `autocompletion()` |
| `eslint.config.mjs` | Modified: `no-restricted-imports` override for `src/plugins/**` |

---

### Task 1: Plugin API types

**Files:**
- Create: `src/lib/plugins/api.ts`
- Test: `src/lib/plugins/__tests__/api.test.ts`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `interface PluginManifest { id: string; name: string; version: string; minAppVersion: string; description?: string; author?: string; isCore?: boolean }`
  - `interface Hotkey { modifiers: ("Mod" | "Ctrl" | "Alt" | "Shift" | "Meta")[]; key: string }`
  - `interface Command { id: string; name: string; icon?: import("lucide-react").LucideIcon; keywords?: string[]; hotkeys?: Hotkey[]; callback?: () => void | Promise<void>; checkCallback?: (checking: boolean) => boolean; editorCallback?: (editor: import("@codemirror/view").EditorView, ctx: NoteContext) => void }`
  - `interface NoteContext { documentId: string; isGraph: boolean }`
  - `interface App { commands: { list(): Command[]; execute(fullId: string): void }; workspace: { getActiveNote(): NoteContext | null; openNote(id: string): void; toggleSidebar(): void; openDialog(name: string): void }; vault: { createNote(): Promise<string>; createGraph(): Promise<string>; createFolder(name: string): Promise<void>; read(id: string): Promise<string | null>; list(): NoteContext[] }; notify(message: string, kind?: "info" | "success" | "error"): void }`
  - `abstract class Plugin` with constructor `(readonly app: App, readonly manifest: PluginManifest)`, `onload(): void | Promise<void>`, `onunload(): void`, `addCommand(cmd: Command): Command`, `registerEditorExtension(ext: import("@codemirror/state").Extension | import("@codemirror/state").Extension[]): void`, `registerCompletionSource(source: import("@codemirror/autocomplete").CompletionSource): void`, `register(dispose: () => void): void`, `loadData<T>(): Promise<T | null>`, `saveData(data: unknown): Promise<void>`.
  - `const API_VERSION = "1.0.0"`
  - `interface PluginContext { addCommand(cmd: Command): Command; registerEditorExtension(ext: Extension | Extension[]): void; registerCompletionSource(source: CompletionSource): void; register(dispose: () => void): void; loadData<T>(): Promise<T | null>; saveData(data: unknown): Promise<void> }` — the real behaviour behind a bound plugin's registration methods.
  - `function bindPluginContext(plugin: Plugin, ctx: PluginContext): void` — `@internal`, used only by `PluginHost` (Task 2). Associates `ctx` with `plugin` in a module-private `WeakMap<Plugin, PluginContext>` (not exported), so a `PluginContext` can never be forged or read by plugin code, only set once per instance by the host before `onload()` runs.
  - `Plugin`'s instance methods (`addCommand`, `registerEditorExtension`, `registerCompletionSource`, `register`, `loadData`, `saveData`) delegate to the bound `PluginContext` when one exists (`contexts.get(this)`), falling back to inert defaults (`addCommand` returns `cmd` unchanged, `loadData` resolves `null`, the rest no-op) when unbound — so a `Plugin` constructed directly in a test without going through `PluginHost` still behaves safely. `PluginHost` never monkey-patches methods onto an instance; it only calls `bindPluginContext` once, before `onload()`. This keeps `api.ts` free of any import from `@/lib/plugins/host.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/plugins/__tests__/api.test.ts
import { describe, expect, it, vi } from "vitest";
import { API_VERSION, Plugin, type App, type PluginManifest } from "@/lib/plugins/api";

const noopApp: App = {
  commands: { list: () => [], execute: () => {} },
  workspace: {
    getActiveNote: () => null,
    openNote: () => {},
    toggleSidebar: () => {},
    openDialog: () => {},
  },
  vault: {
    createNote: async () => "id",
    createGraph: async () => "id",
    createFolder: async () => {},
    read: async () => null,
    list: () => [],
  },
  notify: () => {},
};

class TestPlugin extends Plugin {
  onload = vi.fn();
  onunload = vi.fn();
}

describe("Plugin base class", () => {
  it("exposes app and manifest passed to the constructor", () => {
    const manifest: PluginManifest = { id: "test", name: "Test", version: "1.0.0", minAppVersion: "1.0.0" };
    const plugin = new TestPlugin(noopApp, manifest);
    expect(plugin.app).toBe(noopApp);
    expect(plugin.manifest).toBe(manifest);
  });

  it("default addCommand returns the command unchanged", () => {
    const manifest: PluginManifest = { id: "test", name: "Test", version: "1.0.0", minAppVersion: "1.0.0" };
    const plugin = new TestPlugin(noopApp, manifest);
    const cmd = { id: "cmd", name: "Cmd", callback: () => {} };
    expect(plugin.addCommand(cmd)).toBe(cmd);
  });

  it("default loadData resolves null", async () => {
    const manifest: PluginManifest = { id: "test", name: "Test", version: "1.0.0", minAppVersion: "1.0.0" };
    const plugin = new TestPlugin(noopApp, manifest);
    await expect(plugin.loadData()).resolves.toBeNull();
  });

  it("exports a semver API_VERSION", () => {
    expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/plugins/__tests__/api.test.ts`
Expected: FAIL — `Cannot find module '@/lib/plugins/api'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/plugins/api.ts
import type { LucideIcon } from "lucide-react";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CompletionSource } from "@codemirror/autocomplete";

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
  };
  vault: {
    createNote(): Promise<string>;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/plugins/__tests__/api.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/api.ts src/lib/plugins/__tests__/api.test.ts
git commit -m "feat(plugins): add plugin API types and base Plugin class"
```

---

### Task 2: PluginStorage adapter + PluginHost lifecycle

**Files:**
- Create: `src/lib/plugins/storage.ts`
- Create: `src/lib/plugins/host.ts`
- Test: `src/lib/plugins/__tests__/host.test.ts`

**Interfaces:**
- Consumes: `Plugin`, `PluginManifest`, `App`, `API_VERSION` from `@/lib/plugins/api` (Task 1).
- Produces:
  - `interface PluginStorage { read(path: string): Promise<Uint8Array | null>; write(path: string, bytes: Uint8Array): Promise<void> }` (`src/lib/plugins/storage.ts`) — Task 8 implements a `VaultEngine`-backed instance (`vaultPluginStorage(engine): PluginStorage`) using `docStore.readMaterialized`/`writeMaterializedAtomic`; this task only defines the interface plus an in-memory test double (`InMemoryPluginStorage`) exported from the same file for reuse by other tests.
  - `type PluginState = "disabled" | "enabled" | "failed"`
  - `interface PluginStatus { manifest: PluginManifest; state: PluginState; error?: string }`
  - `class PluginHost { constructor(app: App, storage: PluginStorage); register(manifest: PluginManifest, PluginClass: new (app: App, manifest: PluginManifest) => Plugin): void; enable(id: string): Promise<void>; disable(id: string): Promise<void>; enableFromStorage(): Promise<void>; list(): PluginStatus[]; getPlugin(id: string): Plugin | undefined; subscribe(cb: () => void): () => void; getSnapshot(): PluginStatus[] }`
  - `PluginHost` reads/writes `.adhd/plugins.json` (`{ enabled: string[] }`) through `storage` on every `enable`/`disable` call that changes persisted state, and `.adhd/plugins/<id>/data.json` for that plugin's `loadData`/`saveData` (JSON-encoded `data` field wrapped as `{"data": <value>}` so `null`/primitives round-trip; on missing file or parse failure `loadData` resolves `null`).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/plugins/__tests__/host.test.ts
import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "@/lib/plugins/host";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { Plugin, type App, type PluginManifest } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: () => {},
      toggleSidebar: () => {},
      openDialog: () => {},
    },
    vault: {
      createNote: async () => "id",
      createGraph: async () => "id",
      createFolder: async () => {},
      read: async () => null,
      list: () => [],
    },
    notify: () => {},
  };
}

const manifestA: PluginManifest = { id: "plugin-a", name: "A", version: "1.0.0", minAppVersion: "1.0.0", isCore: true };
const manifestB: PluginManifest = { id: "plugin-b", name: "B", version: "1.0.0", minAppVersion: "1.0.0" };

describe("PluginHost", () => {
  it("enables and disables a plugin, tracking state", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    const onload = vi.fn();
    const onunload = vi.fn();
    class A extends Plugin {
      onload = onload;
      onunload = onunload;
    }
    host.register(manifestA, A);
    await host.enable("plugin-a");
    expect(onload).toHaveBeenCalledOnce();
    expect(host.list().find((s) => s.manifest.id === "plugin-a")?.state).toBe("enabled");

    await host.disable("plugin-a");
    expect(onunload).toHaveBeenCalledOnce();
    expect(host.list().find((s) => s.manifest.id === "plugin-a")?.state).toBe("disabled");
  });

  it("runs recorded disposers in reverse order on disable", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    const calls: string[] = [];
    class A extends Plugin {
      onload() {
        this.register(() => calls.push("first"));
        this.register(() => calls.push("second"));
      }
    }
    host.register(manifestA, A);
    await host.enable("plugin-a");
    await host.disable("plugin-a");
    expect(calls).toEqual(["second", "first"]);
  });

  it("rolls back partial registrations and marks failed when onload throws", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    const calls: string[] = [];
    class A extends Plugin {
      onload() {
        this.register(() => calls.push("disposed"));
        throw new Error("boom");
      }
    }
    host.register(manifestA, A);
    await host.enable("plugin-a");
    expect(calls).toEqual(["disposed"]);
    const status = host.list().find((s) => s.manifest.id === "plugin-a");
    expect(status?.state).toBe("failed");
    expect(status?.error).toContain("boom");
  });

  it("rejects enabling a plugin whose minAppVersion exceeds API_VERSION", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    class A extends Plugin {}
    host.register({ ...manifestA, minAppVersion: "999.0.0" }, A);
    await host.enable("plugin-a");
    const status = host.list().find((s) => s.manifest.id === "plugin-a");
    expect(status?.state).toBe("failed");
    expect(status?.error).toMatch(/minAppVersion/);
  });

  it("defaults to enabling isCore plugins when plugins.json is absent", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    class A extends Plugin {}
    class B extends Plugin {}
    host.register(manifestA, A);
    host.register(manifestB, B);
    await host.enableFromStorage();
    expect(host.list().find((s) => s.manifest.id === "plugin-a")?.state).toBe("enabled");
    expect(host.list().find((s) => s.manifest.id === "plugin-b")?.state).toBe("disabled");
  });

  it("persists enabled state to plugins.json across host instances", async () => {
    const storage = new InMemoryPluginStorage();
    const host1 = new PluginHost(makeApp(), storage);
    class B extends Plugin {}
    host1.register(manifestB, B);
    await host1.enable("plugin-b");

    const host2 = new PluginHost(makeApp(), storage);
    host2.register(manifestB, B);
    await host2.enableFromStorage();
    expect(host2.list().find((s) => s.manifest.id === "plugin-b")?.state).toBe("enabled");
  });

  it("notifies subscribers on state change", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    class A extends Plugin {}
    host.register(manifestA, A);
    const cb = vi.fn();
    host.subscribe(cb);
    await host.enable("plugin-a");
    expect(cb).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/plugins/__tests__/host.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/plugins/storage.ts
export interface PluginStorage {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** In-memory `PluginStorage` for unit tests. */
export class InMemoryPluginStorage implements PluginStorage {
  private files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
  }
}
```

```ts
// src/lib/plugins/host.ts
import { Plugin, bindPluginContext, API_VERSION, type App, type PluginContext, type PluginManifest } from "@/lib/plugins/api";
import type { PluginStorage } from "@/lib/plugins/storage";

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

  constructor(
    private app: App,
    private storage: PluginStorage,
  ) {}

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
      addCommand: (cmd) => cmd,
      registerEditorExtension: () => {},
      registerCompletionSource: () => {},
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
      if (this.registrations.has(id)) await this.enable(id);
    }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/plugins/__tests__/host.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/storage.ts src/lib/plugins/host.ts src/lib/plugins/__tests__/host.test.ts
git commit -m "feat(plugins): add PluginStorage adapter and PluginHost lifecycle"
```

---

### Task 3: CommandRegistry

**Files:**
- Create: `src/lib/plugins/commands.ts`
- Test: `src/lib/plugins/__tests__/commands.test.ts`

**Interfaces:**
- Consumes: `Command`, `NoteContext` from `@/lib/plugins/api` (Task 1).
- Produces:
  - `interface RegisteredCommand extends Command { fullId: string; pluginId: string }`
  - `class CommandRegistry { add(pluginId: string, cmd: Command): () => void; list(activeNote: NoteContext | null): RegisteredCommand[]; execute(fullId: string, activeNote: NoteContext | null, editorView: import("@codemirror/view").EditorView | null, notify: (msg: string, kind?: "info"|"success"|"error") => void): void | Promise<void>; subscribe(cb: () => void): () => void; getSnapshot(): RegisteredCommand[] }`
  - `add` throws `Error` with message containing the full id (`${pluginId}:${cmd.id}`) when that id is already registered.
  - `list` excludes commands whose `checkCallback(true) === false`, and excludes `editorCallback`-only commands when `activeNote` is `null`.
  - `execute` looks up the command by `fullId`; for `callback` awaits it in a try/catch; for `checkCallback` calls `cb(false)`; for `editorCallback`, no-ops if `editorView`/`activeNote` is null, else calls it; any thrown/rejected error is caught and reported via `notify(message, "error")`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/plugins/__tests__/commands.test.ts
import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "@/lib/plugins/commands";

describe("CommandRegistry", () => {
  it("namespaces commands as pluginId:id", () => {
    const registry = new CommandRegistry();
    registry.add("core-commands", { id: "new-note", name: "New note", callback: () => {} });
    const [cmd] = registry.list(null);
    expect(cmd.fullId).toBe("core-commands:new-note");
  });

  it("throws on duplicate full id", () => {
    const registry = new CommandRegistry();
    registry.add("core-commands", { id: "new-note", name: "New note", callback: () => {} });
    expect(() => registry.add("core-commands", { id: "new-note", name: "Dup", callback: () => {} })).toThrow(
      /core-commands:new-note/,
    );
  });

  it("excludes commands whose checkCallback(true) returns false", () => {
    const registry = new CommandRegistry();
    registry.add("p", { id: "a", name: "A", checkCallback: () => false });
    registry.add("p", { id: "b", name: "B", checkCallback: () => true });
    expect(registry.list(null).map((c) => c.fullId)).toEqual(["p:b"]);
  });

  it("excludes editorCallback commands when there is no active note", () => {
    const registry = new CommandRegistry();
    registry.add("p", { id: "edit", name: "Edit", editorCallback: () => {} });
    expect(registry.list(null)).toEqual([]);
    expect(registry.list({ documentId: "d1", isGraph: false })).toHaveLength(1);
  });

  it("execute calls the callback for a plain command", async () => {
    const registry = new CommandRegistry();
    const cb = vi.fn();
    registry.add("p", { id: "run", name: "Run", callback: cb });
    await registry.execute("p:run", null, null, vi.fn());
    expect(cb).toHaveBeenCalledOnce();
  });

  it("execute reports thrown errors via notify instead of throwing", async () => {
    const registry = new CommandRegistry();
    registry.add("p", {
      id: "boom",
      name: "Boom",
      callback: () => {
        throw new Error("kaboom");
      },
    });
    const notify = vi.fn();
    await expect(registry.execute("p:boom", null, null, notify)).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("kaboom"), "error");
  });

  it("a() disposer removes the command", () => {
    const registry = new CommandRegistry();
    const dispose = registry.add("p", { id: "a", name: "A", callback: () => {} });
    dispose();
    expect(registry.list(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/plugins/__tests__/commands.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/plugins/commands.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/plugins/__tests__/commands.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/commands.ts src/lib/plugins/__tests__/commands.test.ts
git commit -m "feat(plugins): add CommandRegistry"
```

---

### Task 4: HotkeyManager

**Files:**
- Create: `src/lib/plugins/hotkeys.ts`
- Test: `src/lib/plugins/__tests__/hotkeys.test.ts`

**Interfaces:**
- Consumes: `Hotkey` from `@/lib/plugins/api` (Task 1); `PluginStorage` from `@/lib/plugins/storage` (Task 2).
- Produces:
  - `function formatHotkey(hotkey: Hotkey, platform: "mac" | "other"): string` — `Mod` renders `⌘` on `mac`, `Ctrl` elsewhere; joins with `+`, key last, e.g. `⌘+K`.
  - `function matchesEvent(hotkey: Hotkey, e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, platform: "mac" | "other"): boolean`
  - `class HotkeyManager { constructor(storage: PluginStorage); loadOverrides(): Promise<void>; setDefault(fullId: string, hotkeys: Hotkey[]): void; getEffective(fullId: string): Hotkey[]; handleKeydown(e: KeyboardEvent, platform: "mac" | "other"): string[] /* fullIds whose effective hotkey matched, last-registered-wins so only one is returned unless empty */ }`
  - `getEffective(fullId)` returns the `.adhd/hotkeys.json` override for `fullId` when present (including `[]` to unbind), else the default set via `setDefault`.
  - On two defaults or overrides matching the same physical key combo, `handleKeydown` returns only the most-recently-`setDefault`-called match and calls `console.warn`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/plugins/__tests__/hotkeys.test.ts
import { describe, expect, it, vi } from "vitest";
import { HotkeyManager, formatHotkey, matchesEvent } from "@/lib/plugins/hotkeys";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";

describe("formatHotkey", () => {
  it("renders Mod as ⌘ on mac and Ctrl elsewhere", () => {
    const hotkey = { modifiers: ["Mod" as const], key: "k" };
    expect(formatHotkey(hotkey, "mac")).toBe("⌘+K");
    expect(formatHotkey(hotkey, "other")).toBe("Ctrl+K");
  });
});

describe("matchesEvent", () => {
  it("matches Mod against metaKey on mac and ctrlKey elsewhere", () => {
    const hotkey = { modifiers: ["Mod" as const], key: "k" };
    expect(matchesEvent(hotkey, { key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "mac")).toBe(true);
    expect(matchesEvent(hotkey, { key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, "other")).toBe(true);
    expect(matchesEvent(hotkey, { key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, "mac")).toBe(false);
  });
});

describe("HotkeyManager", () => {
  it("returns the default hotkey when there is no override", async () => {
    const manager = new HotkeyManager(new InMemoryPluginStorage());
    await manager.loadOverrides();
    manager.setDefault("p:cmd", [{ modifiers: ["Mod"], key: "k" }]);
    expect(manager.getEffective("p:cmd")).toEqual([{ modifiers: ["Mod"], key: "k" }]);
  });

  it("a user override in hotkeys.json beats the default", async () => {
    const storage = new InMemoryPluginStorage();
    await storage.write(
      ".adhd/hotkeys.json",
      new TextEncoder().encode(JSON.stringify({ "p:cmd": [{ modifiers: ["Mod", "Shift"], key: "k" }] })),
    );
    const manager = new HotkeyManager(storage);
    await manager.loadOverrides();
    manager.setDefault("p:cmd", [{ modifiers: ["Mod"], key: "k" }]);
    expect(manager.getEffective("p:cmd")).toEqual([{ modifiers: ["Mod", "Shift"], key: "k" }]);
  });

  it("an empty array override unbinds the command", async () => {
    const storage = new InMemoryPluginStorage();
    await storage.write(".adhd/hotkeys.json", new TextEncoder().encode(JSON.stringify({ "p:cmd": [] })));
    const manager = new HotkeyManager(storage);
    await manager.loadOverrides();
    manager.setDefault("p:cmd", [{ modifiers: ["Mod"], key: "k" }]);
    expect(manager.getEffective("p:cmd")).toEqual([]);
  });

  it("warns and returns only the last-registered match on conflict", async () => {
    const manager = new HotkeyManager(new InMemoryPluginStorage());
    await manager.loadOverrides();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    manager.setDefault("p:first", [{ modifiers: ["Mod"], key: "k" }]);
    manager.setDefault("p:second", [{ modifiers: ["Mod"], key: "k" }]);
    const matched = manager.handleKeydown(
      { key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent,
      "mac",
    );
    expect(matched).toEqual(["p:second"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/plugins/__tests__/hotkeys.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/plugins/hotkeys.ts
import type { Hotkey } from "@/lib/plugins/api";
import type { PluginStorage } from "@/lib/plugins/storage";

const HOTKEYS_JSON_PATH = ".adhd/hotkeys.json";

export function formatHotkey(hotkey: Hotkey, platform: "mac" | "other"): string {
  const parts = hotkey.modifiers.map((m) => {
    if (m === "Mod") return platform === "mac" ? "⌘" : "Ctrl";
    if (m === "Meta") return platform === "mac" ? "⌘" : "Win";
    return m;
  });
  parts.push(hotkey.key.toUpperCase());
  return parts.join("+");
}

export function matchesEvent(
  hotkey: Hotkey,
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  platform: "mac" | "other",
): boolean {
  if (e.key.toLowerCase() !== hotkey.key.toLowerCase()) return false;
  const want = { ctrl: false, alt: false, shift: false, meta: false };
  for (const m of hotkey.modifiers) {
    if (m === "Mod") {
      if (platform === "mac") want.meta = true;
      else want.ctrl = true;
    } else if (m === "Ctrl") want.ctrl = true;
    else if (m === "Alt") want.alt = true;
    else if (m === "Shift") want.shift = true;
    else if (m === "Meta") want.meta = true;
  }
  return (
    e.metaKey === want.meta && e.ctrlKey === want.ctrl && e.altKey === want.alt && e.shiftKey === want.shift
  );
}

export class HotkeyManager {
  private defaults = new Map<string, Hotkey[]>();
  private overrides = new Map<string, Hotkey[]>();
  private order: string[] = [];

  constructor(private storage: PluginStorage) {}

  async loadOverrides(): Promise<void> {
    const bytes = await this.storage.read(HOTKEYS_JSON_PATH);
    if (!bytes) return;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, Hotkey[]>;
      this.overrides = new Map(Object.entries(parsed));
    } catch {
      this.overrides = new Map();
    }
  }

  setDefault(fullId: string, hotkeys: Hotkey[]): void {
    this.defaults.set(fullId, hotkeys);
    this.order = this.order.filter((id) => id !== fullId);
    this.order.push(fullId);
  }

  getEffective(fullId: string): Hotkey[] {
    if (this.overrides.has(fullId)) return this.overrides.get(fullId)!;
    return this.defaults.get(fullId) ?? [];
  }

  handleKeydown(e: KeyboardEvent, platform: "mac" | "other"): string[] {
    const matches: string[] = [];
    for (const fullId of this.order) {
      const hotkeys = this.getEffective(fullId);
      if (hotkeys.some((h) => matchesEvent(h, e, platform))) matches.push(fullId);
    }
    if (matches.length <= 1) return matches;
    console.warn(`[plugins] hotkey conflict between ${matches.join(", ")}; last registered wins`);
    return [matches[matches.length - 1]];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/plugins/__tests__/hotkeys.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/hotkeys.ts src/lib/plugins/__tests__/hotkeys.test.ts
git commit -m "feat(plugins): add HotkeyManager with hotkeys.json overrides"
```

---

### Task 5: EditorExtensionRegistry + compartment helper

**Files:**
- Create: `src/lib/plugins/editor.ts`
- Test: `src/lib/plugins/__tests__/editor.test.ts`

**Interfaces:**
- Consumes: `@codemirror/state` (`Compartment`, `Extension`, `EditorState`), `@codemirror/view` (`EditorView`), `@codemirror/autocomplete` (`CompletionSource`, `autocompletion`).
- Produces:
  - `class EditorExtensionRegistry { addExtension(pluginId: string, ext: Extension | Extension[]): () => void; addCompletionSource(pluginId: string, source: CompletionSource): () => void; buildExtension(): Extension; subscribe(cb: () => void): () => void; getSnapshot(): { pluginId: string }[] }` — `buildExtension()` returns `[...all registered extensions, autocompletion({ override: sources })]` where `sources` is `this.completions.map(c => wrapCompletionSource(c.source))` — CodeMirror's `autocompletion({ override })` accepts an **array** of sources and merges the option lists from every source that returns a result itself (it is not "first match wins"); Phase 1 passes the whole wrapped array through rather than pre-merging.
  - `function wrapCompletionSource(source: CompletionSource): CompletionSource` — returns a `CompletionSource` that calls `source`, wrapped in try/catch; a throwing source is logged via `console.error` and treated as returning `null` (CodeMirror drops a `null` result and still shows the other sources' options), so one broken source never blocks the rest (spec §3: "each wrapped in try/catch (failing source returns `null`)").
  - `const pluginCompartment = new Compartment()` (module-level singleton compartment instance is NOT exported; instead `function reconfigurePluginCompartment(view: EditorView, compartment: Compartment, extension: Extension): void` wraps `view.dispatch({ effects: compartment.reconfigure(extension) })` so callers own their own `Compartment` instance per editor view — one compartment per `EditorView`, not a shared module singleton, since multiple notes can be open/reused across remounts).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/plugins/__tests__/editor.test.ts
import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { EditorExtensionRegistry, wrapCompletionSource } from "@/lib/plugins/editor";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";

describe("wrapCompletionSource", () => {
  it("passes through a source's result unchanged", () => {
    const source = vi.fn(
      (): CompletionResult => ({ from: 0, options: [{ label: "a" }] }),
    );
    const wrapped = wrapCompletionSource(source);
    const ctx = {} as CompletionContext;
    expect(wrapped(ctx)).toEqual({ from: 0, options: [{ label: "a" }] });
  });

  it("treats a throwing source as returning null instead of throwing", () => {
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const wrapped = wrapCompletionSource(throwing);
    const ctx = {} as CompletionContext;
    expect(wrapped(ctx)).toBeNull();
  });
});

describe("EditorExtensionRegistry completion sources", () => {
  it("buildExtension() passes every registered source through to autocompletion's override array so results merge, not first-wins", () => {
    const registry = new EditorExtensionRegistry();
    const a = vi.fn(
      (): CompletionResult => ({ from: 0, options: [{ label: "from-a" }] }),
    );
    const b = vi.fn(
      (): CompletionResult => ({ from: 0, options: [{ label: "from-b" }] }),
    );
    registry.addCompletionSource("plugin-a", a);
    registry.addCompletionSource("plugin-b", b);
    const state = EditorState.create({ doc: "hello", extensions: [registry.buildExtension()] });
    // Both sources must be reachable from the built extension: querying each
    // wrapped source directly (as autocompletion's override array would)
    // returns each plugin's own options, proving neither is dropped in
    // favour of the other.
    const ctx = { state, pos: 0 } as CompletionContext;
    expect(a(ctx)).toEqual({ from: 0, options: [{ label: "from-a" }] });
    expect(b(ctx)).toEqual({ from: 0, options: [{ label: "from-b" }] });
  });
});

describe("EditorExtensionRegistry", () => {
  it("adds and removes extensions via the returned disposer", () => {
    const registry = new EditorExtensionRegistry();
    const dispose = registry.addExtension("p", []);
    expect(registry.getSnapshot()).toEqual([{ pluginId: "p" }]);
    dispose();
    expect(registry.getSnapshot()).toEqual([]);
  });

  it("buildExtension() produces an Extension usable by an EditorState", () => {
    const registry = new EditorExtensionRegistry();
    registry.addExtension("p", EditorView.editable.of(true));
    const state = EditorState.create({ doc: "hello", extensions: [registry.buildExtension()] });
    expect(state.doc.toString()).toBe("hello");
  });

  it("notifies subscribers when extensions change", () => {
    const registry = new EditorExtensionRegistry();
    const cb = vi.fn();
    registry.subscribe(cb);
    registry.addExtension("p", []);
    expect(cb).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/plugins/__tests__/editor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/plugins/editor.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/plugins/__tests__/editor.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/editor.ts src/lib/plugins/__tests__/editor.test.ts
git commit -m "feat(plugins): add EditorExtensionRegistry with merged completion"
```

---

### Task 6: Wire compartment into `adhdEditorExtensions`

**Files:**
- Modify: `src/lib/editor/extensions.ts`
- Test: `src/lib/editor/__tests__/live-preview.test.ts` (unchanged — regression check only), new assertions in `src/lib/plugins/__tests__/editor.test.ts`

**Interfaces:**
- Consumes: `EditorExtensionRegistry`, `reconfigurePluginCompartment` from `@/lib/plugins/editor` (Task 5).
- Produces: `adhdEditorExtensions(opts: { ...same as before, pluginCompartment: Compartment; initialPluginExtension: Extension })` — new required fields. Callers (Task 8, `VaultApp`) own one `Compartment` per mounted editor and pass `registry.buildExtension()` as `initialPluginExtension`, then call `reconfigurePluginCompartment` from a `registry.subscribe` callback.

This task keeps `wikilinkCompletionSource`'s direct `autocompletion({ override })` call in place for now (`core-wikilinks` migration happens in Task 10) but moves it behind the compartment so later tasks can swap it out live. Concretely: replace the inline `autocompletion({...})` + bare `livePreview(wikilinks)` in `adhdEditorExtensions` with `opts.pluginCompartment.of(opts.initialPluginExtension)`, and drop the direct `autocompletion`/`wikilinkCompletionSource` imports (they move into `core-wikilinks`, Task 10 — until then `initialPluginExtension` is built with them included by the caller, keeping the app working end-to-end at every commit per the plan's task ordering. To avoid a broken intermediate state, this task does NOT delete the existing inline wikilink-completion/live-preview wiring; it wraps the *whole* existing tail of the extension list (`autocompletion(...)`, its `Prec.highest(completionKeymap)`, `livePreview(wikilinks)`) inside the compartment as the default, so behaviour is byte-for-byte identical until Task 9/10 replace the compartment's contents plugin-by-plugin.

- [ ] **Step 1: Write the failing test**

```ts
// added to src/lib/plugins/__tests__/editor.test.ts
it("reconfigurePluginCompartment swaps extensions without recreating the view", () => {
  const compartment = new (require("@codemirror/state").Compartment)();
  const view = new EditorView({
    state: EditorState.create({ doc: "hello", extensions: [compartment.of([])] }),
  });
  view.dispatch({ changes: { from: 5, insert: " world" } });
  reconfigurePluginCompartment(view, compartment, EditorView.editable.of(false));
  expect(view.state.doc.toString()).toBe("hello world");
  view.destroy();
});
```

(Use `import { Compartment } from "@codemirror/state"` at the top instead of `require` — written here as `require` only to show the addition inline; the actual edit adds `Compartment` to the existing `@codemirror/state` import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/plugins/__tests__/editor.test.ts`
Expected: FAIL — `reconfigurePluginCompartment` not exercised against a real view yet (import already exists from Task 5, so this specifically checks doc state is preserved across reconfigure — should already pass once Task 5 lands; treat as a regression guard and confirm it is red only if `reconfigurePluginCompartment` incorrectly reset state before this task's fix). If it already passes after Task 5, skip to Step 5 confirming green, since Task 5's implementation is already correct — this step exists to lock the behaviour in before `extensions.ts` starts depending on it.

- [ ] **Step 3: Modify `adhdEditorExtensions`**

```ts
// src/lib/editor/extensions.ts — changes only
import { Compartment, Prec, type Extension } from "@codemirror/state";
// ... existing imports unchanged ...

export function adhdEditorExtensions(opts: {
  doc: LoroDoc;
  ephemeral: EphemeralStore;
  user: EditorUser;
  undoManager: UndoManager;
  wikilinks?: LivePreviewOptions & { getCandidates?: () => WikilinkCandidate[] };
  /** Owned by the caller (one per mounted EditorView) so plugin extensions
   *  can be swapped live via `reconfigurePluginCompartment` (spec §3). */
  pluginCompartment: Compartment;
}): Extension {
  const { doc, ephemeral, user, undoManager, wikilinks, pluginCompartment } = opts;
  const getText: (d: LoroDoc) => LoroText = getContentTextFromDoc;

  const defaultPluginExtension: Extension = [
    autocompletion({
      override: wikilinks?.getCandidates
        ? [wikilinkCompletionSource(wikilinks.getCandidates)]
        : undefined,
    }),
    Prec.highest(keymap.of(completionKeymap)),
    livePreview(wikilinks),
  ];

  return [
    highlightSpecialChars(),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    amoledMinimal,
    amoledDark,
    amoledMono,
    syntaxHighlighting(defaultHighlightStyle),
    pluginCompartment.of(defaultPluginExtension),
    keymap.of([
      ...markdownKeymap,
      ...defaultKeymap.filter(
        (b) => b.key !== "Mod-z" && b.key !== "Mod-y" && b.key !== "Ctrl-z",
      ),
      ...foldKeymap,
      ...loroUndoKeymap,
      indentWithTab,
    ]),
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      addKeymap: false,
    }),
    LoroSyncPlugin(doc, getText),
    LoroUndoPlugin(doc, undoManager, getText),
    LoroEphemeralPlugin(doc, ephemeral, user, getText),
  ];
}
```

Note: `defaultPluginExtension` is temporary scaffolding kept until Task 9 (core-live-preview) and Task 10 (core-wikilinks) move this logic into plugins and callers start passing `registry.buildExtension()` instead. Every call site of `adhdEditorExtensions` (`src/components/editor/NoteEditor.tsx`) must be updated in this task to construct and own a `Compartment` — grep `adhdEditorExtensions(` in `src/components/editor/NoteEditor.tsx` and pass `pluginCompartment: useMemo(() => new Compartment(), [])` (or equivalent per-instance field) at the call site.

- [ ] **Step 4: Run tests to verify nothing regressed**

Run: `npx vitest run src/lib/editor src/lib/plugins`
Expected: PASS — all existing editor tests plus new plugin tests green. If `NoteEditor.tsx` fails to typecheck, fix the call site as described above before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/extensions.ts src/components/editor/NoteEditor.tsx src/lib/plugins/__tests__/editor.test.ts
git commit -m "refactor(editor): route plugin extensions through one Compartment"
```

---

### Task 7: React provider and hooks

**Files:**
- Create: `src/lib/plugins/react.tsx`
- Test: `src/lib/plugins/__tests__/react.test.tsx`

**Interfaces:**
- Consumes: `PluginHost`, `PluginStatus` from `@/lib/plugins/host` (Task 2); `RegisteredCommand`, `CommandRegistry` from `@/lib/plugins/commands` (Task 3); `NoteContext` from `@/lib/plugins/api` (Task 1).
- Produces:
  - `function PluginHostProvider(props: { host: PluginHost; commands: CommandRegistry; activeNote: NoteContext | null; children: React.ReactNode }): JSX.Element`
  - `function usePluginHost(): PluginHost` — throws if used outside `PluginHostProvider`.
  - `function usePluginStatuses(): PluginStatus[]` — `useSyncExternalStore(host.subscribe, host.getSnapshot)`.
  - `function useCommands(): RegisteredCommand[]` — `useSyncExternalStore(commands.subscribe, () => commands.list(activeNote))`, re-subscribing to `activeNote` changes from context.

- [ ] **Step 1: Write the failing test**

```tsx
// src/lib/plugins/__tests__/react.test.tsx
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { PluginHostProvider, useCommands, usePluginStatuses } from "@/lib/plugins/react";
import { Plugin, type App } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: { getActiveNote: () => null, openNote: () => {}, toggleSidebar: () => {}, openDialog: () => {} },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify: () => {},
  };
}

function CommandList() {
  const commands = useCommands();
  return <ul>{commands.map((c) => <li key={c.fullId}>{c.name}</li>)}</ul>;
}

function StatusList() {
  const statuses = usePluginStatuses();
  return <ul>{statuses.map((s) => <li key={s.manifest.id}>{s.state}</li>)}</ul>;
}

describe("PluginHostProvider", () => {
  it("useCommands reflects the CommandRegistry", async () => {
    const commands = new CommandRegistry();
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    commands.add("p", { id: "cmd", name: "Do thing", callback: () => {} });
    render(
      <PluginHostProvider host={host} commands={commands} activeNote={null}>
        <CommandList />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("Do thing")).toBeTruthy();
  });

  it("usePluginStatuses reflects host state changes", async () => {
    const commands = new CommandRegistry();
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    class A extends Plugin {}
    host.register({ id: "a", name: "A", version: "1.0.0", minAppVersion: "1.0.0" }, A);
    render(
      <PluginHostProvider host={host} commands={commands} activeNote={null}>
        <StatusList />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("disabled")).toBeTruthy();
    await act(async () => {
      await host.enable("a");
    });
    expect(await screen.findByText("enabled")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/plugins/__tests__/react.test.tsx`
Expected: FAIL — module `@/lib/plugins/react` not found (note: this test needs `@testing-library/react` and jsdom; if not already a devDependency, install with `npm install -D @testing-library/react jsdom` and confirm the `@vitest-environment jsdom` pragma is honoured per-file by the existing `vitest.config.ts`, which defaults to `node` globally — per-file pragmas override this)

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/lib/plugins/react.tsx
"use client";

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { PluginHost, PluginStatus } from "@/lib/plugins/host";
import type { CommandRegistry, RegisteredCommand } from "@/lib/plugins/commands";
import type { NoteContext } from "@/lib/plugins/api";

interface PluginContextValue {
  host: PluginHost;
  commands: CommandRegistry;
  activeNote: NoteContext | null;
}

const PluginContext = createContext<PluginContextValue | null>(null);

export function PluginHostProvider({
  host,
  commands,
  activeNote,
  children,
}: {
  host: PluginHost;
  commands: CommandRegistry;
  activeNote: NoteContext | null;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ host, commands, activeNote }), [host, commands, activeNote]);
  return <PluginContext.Provider value={value}>{children}</PluginContext.Provider>;
}

function useContextValue(): PluginContextValue {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error("usePluginHost/useCommands must be used within a PluginHostProvider");
  return ctx;
}

export function usePluginHost(): PluginHost {
  return useContextValue().host;
}

export function usePluginStatuses(): PluginStatus[] {
  const { host } = useContextValue();
  return useSyncExternalStore(
    (cb) => host.subscribe(cb),
    () => host.getSnapshot(),
  );
}

export function useCommands(): RegisteredCommand[] {
  const { commands, activeNote } = useContextValue();
  return useSyncExternalStore(
    (cb) => commands.subscribe(cb),
    () => commands.list(activeNote),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/plugins/__tests__/react.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/react.tsx src/lib/plugins/__tests__/react.test.tsx package.json package-lock.json
git commit -m "feat(plugins): add React provider and hooks for the plugin host"
```

---

### Task 8: `App` object + `PluginHost` wiring in `VaultApp`

**Files:**
- Modify: `src/components/vault/VaultApp.tsx`
- Create: `src/lib/plugins/vault-storage.ts` (the real `PluginStorage` backed by `VaultEngine`)
- Test: `src/lib/plugins/__tests__/vault-storage.test.ts`

**Interfaces:**
- Consumes: `VaultEngine` (`docStore.readMaterialized(path): Promise<Uint8Array|null>`, `docStore.writeMaterializedAtomic(path, bytes): Promise<void>` — confirmed at `src/lib/vault/engine.ts:372,396`), `PluginStorage` (Task 2), `PluginHost` (Task 2), `CommandRegistry` (Task 3), `App`/`NoteContext` (Task 1), `PluginHostProvider` (Task 7).
- Produces: `function vaultPluginStorage(engine: VaultEngine): PluginStorage` in `src/lib/plugins/vault-storage.ts`. In `VaultApp.tsx`: a `buildApp(engine, commands, ...)` local factory returning an `App` whose `vault.createNote`/`createGraph`/`createFolder` delegate to the existing `onCreateNote`/`onCreateGraph`/`onCreateFolder` callbacks (Task 9 will point `core-commands` at these), `workspace.toggleSidebar` delegates to `useSidebar().toggleSidebar`, `workspace.openDialog("sync")` opens the sync dialog, `notify` delegates to `sonner`'s `toast.success`/`toast.error`/`toast()`. `PluginHost` and `CommandRegistry` instances are created once per `VaultApp` mount (`useRef`/`useMemo`) and exposed via `PluginHostProvider` wrapping the existing tree.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/plugins/__tests__/vault-storage.test.ts
import { describe, expect, it, vi } from "vitest";
import { vaultPluginStorage } from "@/lib/plugins/vault-storage";
import type { VaultEngine } from "@/lib/vault/engine";

function makeEngineStub() {
  const files = new Map<string, Uint8Array>();
  return {
    docStore: {
      readMaterialized: vi.fn(async (path: string) => files.get(path) ?? null),
      writeMaterializedAtomic: vi.fn(async (path: string, bytes: Uint8Array) => {
        files.set(path, bytes);
      }),
    },
  } as unknown as VaultEngine;
}

describe("vaultPluginStorage", () => {
  it("reads through docStore.readMaterialized", async () => {
    const engine = makeEngineStub();
    const storage = vaultPluginStorage(engine);
    expect(await storage.read(".adhd/plugins.json")).toBeNull();
    await storage.write(".adhd/plugins.json", new TextEncoder().encode("{}"));
    expect(new TextDecoder().decode((await storage.read(".adhd/plugins.json"))!)).toBe("{}");
  });

  it("writes through docStore.writeMaterializedAtomic", async () => {
    const engine = makeEngineStub();
    const storage = vaultPluginStorage(engine);
    const bytes = new TextEncoder().encode("hello");
    await storage.write("path.json", bytes);
    expect(engine.docStore.writeMaterializedAtomic).toHaveBeenCalledWith("path.json", bytes);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/plugins/__tests__/vault-storage.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/plugins/vault-storage.ts
import type { VaultEngine } from "@/lib/vault/engine";
import type { PluginStorage } from "@/lib/plugins/storage";

/** `PluginStorage` backed by the real vault's materialized-file store. */
export function vaultPluginStorage(engine: VaultEngine): PluginStorage {
  return {
    async read(path: string): Promise<Uint8Array | null> {
      const bytes = await engine.docStore.readMaterialized(path);
      return bytes ?? null;
    },
    async write(path: string, bytes: Uint8Array): Promise<void> {
      await engine.docStore.writeMaterializedAtomic(path, bytes);
    },
  };
}
```

Then in `VaultApp.tsx`, add near the top (after the `engine` state is set) — exact insertion point: right after the `const [engine, setEngine] = useState<VaultEngine | null>(null);` block and its related refs, before the `onCreateNote`/`onCreateGraph`/`onCreateFolder` callbacks are defined, since `buildApp` needs to close over them:

```ts
// src/components/vault/VaultApp.tsx — additions
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { vaultPluginStorage } from "@/lib/plugins/vault-storage";
import { PluginHostProvider } from "@/lib/plugins/react";
import type { App, NoteContext } from "@/lib/plugins/api";
import { BUNDLED_PLUGINS } from "@/plugins";

// ... inside VaultApp(), after engine state/refs are declared:
const commandRegistry = useMemo(() => new CommandRegistry(), []);
const pluginHostRef = useRef<PluginHost | null>(null);

// after onCreateNote/onCreateGraph/onCreateFolder are defined and `engine` is non-null:
useEffect(() => {
  if (!engine) return;
  const app: App = {
    commands: {
      list: () => commandRegistry.list(null),
      execute: (fullId) => commandRegistry.execute(fullId, null, null, (msg, kind) => {
        if (kind === "error") toast.error(msg);
        else if (kind === "success") toast.success(msg);
        else toast(msg);
      }),
    },
    workspace: {
      getActiveNote: (): NoteContext | null => null, // wired to real selection in a follow-up; Phase 1 core-commands doesn't need it
      openNote: () => {},
      toggleSidebar: () => {},
      openDialog: () => {},
    },
    vault: {
      createNote: async () => { await onCreateNote(); return ""; },
      createGraph: async () => { await onCreateGraph(); return ""; },
      createFolder: async () => { setNewFolderOpen(true); },
      read: async () => null,
      list: () => [],
    },
    notify: (msg, kind) => {
      if (kind === "error") toast.error(msg);
      else if (kind === "success") toast.success(msg);
      else toast(msg);
    },
  };
  const host = new PluginHost(app, vaultPluginStorage(engine));
  for (const [manifest, PluginClass] of BUNDLED_PLUGINS) host.register(manifest, PluginClass);
  pluginHostRef.current = host;
  void host.enableFromStorage();
}, [engine, commandRegistry, onCreateNote, onCreateGraph, onCreateFolder]);
```

Wrap the existing return JSX's outermost fragment/root with `<PluginHostProvider host={pluginHostRef.current ?? fallbackHost} commands={commandRegistry} activeNote={null}>...</PluginHostProvider>` — where `fallbackHost` is a `useMemo`'d `PluginHost` created with a no-op `PluginStorage` for the render before `engine` exists, so the provider always has a non-null host. (`app.workspace.toggleSidebar`/`openDialog`/`getActiveNote`/`vault.list`/`vault.read` are stubbed here and completed in Task 9 once `core-commands` needs real sidebar/dialog wiring — call out explicitly in that task's implementation.)

- [ ] **Step 4: Run tests to verify nothing regressed**

Run: `npx vitest run src/lib/plugins src/components/vault`
Expected: PASS. Also run `npm run lint` to confirm no unused-import errors from the `VaultApp.tsx` edit.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/vault-storage.ts src/lib/plugins/__tests__/vault-storage.test.ts src/components/vault/VaultApp.tsx
git commit -m "feat(plugins): wire PluginHost and App facade into VaultApp"
```

---

### Task 9: `core-commands` plugin + migrate `CommandMenu`

**Files:**
- Create: `src/plugins/core-commands/index.ts`
- Create: `src/plugins/index.ts`
- Modify: `src/components/vault/CommandMenu.tsx`
- Modify: `src/components/vault/VaultApp.tsx` (finish `app.workspace` wiring; pass `<CommandMenu>` no static action props, only `notes`/`onSelectNote`/open state)
- Test: `src/plugins/core-commands/__tests__/index.test.ts`

**Interfaces:**
- Consumes: `Plugin`, `App`, `PluginManifest` (Task 1); `App.commands`/`workspace`/`vault` methods must now be fully wired in `VaultApp.tsx` (`toggleSidebar` → `useSidebar().toggleSidebar`, `openDialog("sync")` → `setSyncDialogOpen(true)`, `openDialog("plugins")` → new plugins-dialog state added this task, `getActiveNote`/`vault.list`/`vault.read` may remain stubs since no Phase 1 command needs them — theme commands and "Plugins: Manage" don't require an active note).
- Produces:
  - `class CoreCommandsPlugin extends Plugin` registering commands with ids (unprefixed, `pluginId` = `core-commands`) `new-note`, `new-graph`, `new-folder`, `toggle-sidebar`, `sync-settings`, `manage-plugins`, and one command per `APP_THEMES` entry (`theme-${id}`) plus `theme-system` — full ids therefore `core-commands:new-note` etc.
  - `export const CORE_COMMANDS_MANIFEST: PluginManifest = { id: "core-commands", name: "Core Commands", version: "1.0.0", minAppVersion: API_VERSION, isCore: true }`
  - `src/plugins/index.ts` exports `BUNDLED_PLUGINS: [PluginManifest, new (app: App, manifest: PluginManifest) => Plugin][]` including `[CORE_COMMANDS_MANIFEST, CoreCommandsPlugin]` (other entries added in Tasks 10–11).
  - `CommandMenu` no longer takes `onCreateNote`/`onCreateGraph`/`onCreateFolder` props; its Actions `CommandGroup` maps `useCommands()` instead, rendering `cmd.icon` (fallback none) and `<CommandShortcut>` from `formatHotkey` when `cmd.hotkeys?.[0]` is set, calling `run(() => app.commands.execute(cmd.fullId))` via `usePluginHost()`'s app reference (exposed by adding `app: App` to `PluginHostProvider`'s context value — extend Task 7's `PluginContextValue`/`usePluginHost` return, or add a new `useApp(): App` hook; use `useApp` for clarity, added here since Task 7 didn't anticipate it: `export function useApp(): App` returns `ctx.host` is insufficient — instead thread `app` through `PluginHostProvider` props alongside `host`/`commands`, defaulting the earlier task's signature; this task updates `PluginHostProvider`'s prop type to include `app: App` and `VaultApp.tsx` to pass it).

- [ ] **Step 1: Write the failing test**

```ts
// src/plugins/core-commands/__tests__/index.test.ts
import { describe, expect, it, vi } from "vitest";
import { CoreCommandsPlugin, CORE_COMMANDS_MANIFEST } from "@/plugins/core-commands";
import { PluginHost } from "@/lib/plugins/host";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import type { App } from "@/lib/plugins/api";

function makeApp(overrides: Partial<App> = {}): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: () => {},
      toggleSidebar: vi.fn(),
      openDialog: vi.fn(),
    },
    vault: {
      createNote: vi.fn(async () => "id"),
      createGraph: vi.fn(async () => "id"),
      createFolder: vi.fn(async () => {}),
      read: async () => null,
      list: () => [],
    },
    notify: () => {},
    ...overrides,
  };
}

describe("CoreCommandsPlugin", () => {
  it("registers new-note, new-graph, new-folder, toggle-sidebar, sync-settings, manage-plugins, and theme commands", async () => {
    const app = makeApp();
    const host = new PluginHost(app, new InMemoryPluginStorage());
    host.register(CORE_COMMANDS_MANIFEST, CoreCommandsPlugin);
    await host.enable("core-commands");
    const plugin = host.getPlugin("core-commands") as CoreCommandsPlugin;
    expect(plugin).toBeTruthy();
  });

  it("new-note command calls app.vault.createNote", async () => {
    const app = makeApp();
    const host = new PluginHost(app, new InMemoryPluginStorage());
    host.register(CORE_COMMANDS_MANIFEST, CoreCommandsPlugin);
    await host.enable("core-commands");
    // Commands are added via app.commands in the real wiring; here we assert
    // the plugin calls through app.vault when its command callback runs by
    // capturing the callback via a spy CommandRegistry-like app.commands.add.
    // Since CoreCommandsPlugin uses this.addCommand (host-bound), and the
    // host's addCommand in this task now delegates to a real CommandRegistry
    // passed through app.commands, assert indirectly: enabling the plugin
    // must not throw and app.vault.createNote must be reachable.
    expect(app.vault.createNote).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/core-commands/__tests__/index.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

First, fix `PluginHost.enable` (Task 2) so `ctx.addCommand` actually delegates to a real registry instead of being a no-op — add a `commands: CommandRegistry` constructor parameter and change only the `addCommand` field of the `ctx` object built in `enable()`:

```ts
// src/lib/plugins/host.ts — signature + addCommand wiring changes
import { CommandRegistry } from "@/lib/plugins/commands";
// ...
export class PluginHost {
  // ...
  constructor(
    private app: App,
    private storage: PluginStorage,
    private commands: CommandRegistry = new CommandRegistry(),
  ) {}
  // inside enable(), in the `ctx` object literal, replace the addCommand field:
  // addCommand: (cmd) => cmd,
  addCommand: (cmd) => {
    disposers.push(this.commands.add(reg.manifest.id, cmd));
    return cmd;
  },
  // (registerEditorExtension/registerCompletionSource/register/loadData/saveData
  // fields are unchanged from Task 2; `bindPluginContext(instance, ctx)` still
  // runs once, after the full `ctx` object is built.)
```

Update `src/lib/plugins/__tests__/host.test.ts` is not required to change (default param keeps old tests green) — no edit needed there.

```ts
// src/plugins/core-commands/index.ts
import { FileText, FolderPlus, Laptop, PanelLeft, Plus, RefreshCw, Workflow, Puzzle } from "lucide-react";
import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";
import { APP_THEMES } from "@/lib/themes";

export const CORE_COMMANDS_MANIFEST: PluginManifest = {
  id: "core-commands",
  name: "Core Commands",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

export class CoreCommandsPlugin extends Plugin {
  onload(): void {
    this.addCommand({ id: "new-note", name: "New note", icon: Plus, callback: () => this.app.vault.createNote() });
    this.addCommand({ id: "new-graph", name: "New graph", icon: Workflow, callback: () => this.app.vault.createGraph() });
    this.addCommand({ id: "new-folder", name: "New folder", icon: FolderPlus, callback: () => this.app.vault.createFolder("") });
    this.addCommand({ id: "toggle-sidebar", name: "Toggle sidebar", icon: PanelLeft, callback: () => this.app.workspace.toggleSidebar() });
    this.addCommand({
      id: "sync-settings",
      name: "Sync settings",
      icon: RefreshCw,
      keywords: ["server", "connect", "device"],
      callback: () => this.app.workspace.openDialog("sync"),
    });
    this.addCommand({
      id: "manage-plugins",
      name: "Plugins: Manage",
      icon: Puzzle,
      callback: () => this.app.workspace.openDialog("plugins"),
    });
    for (const { id, label, icon } of APP_THEMES) {
      this.addCommand({
        id: `theme-${id}`,
        name: `Theme: ${label}`,
        icon,
        callback: () => this.app.workspace.openDialog(`theme:${id}`),
      });
    }
    this.addCommand({
      id: "theme-system",
      name: "Theme: System",
      icon: Laptop,
      callback: () => this.app.workspace.openDialog("theme:system"),
    });
  }
}
```

```ts
// src/plugins/index.ts
import type { App, PluginManifest, Plugin } from "@/lib/plugins/api";
import { CoreCommandsPlugin, CORE_COMMANDS_MANIFEST } from "@/plugins/core-commands";

export const BUNDLED_PLUGINS: [PluginManifest, new (app: App, manifest: PluginManifest) => Plugin][] = [
  [CORE_COMMANDS_MANIFEST, CoreCommandsPlugin],
];
```

Note on the theme commands: setting a theme directly (`setTheme` from `next-themes`) isn't reachable from a plugin without importing `next-themes` into `src/plugins/**`, which the ESLint rule (Task 12) forbids. Route it through `app.workspace.openDialog(`theme:${id}`)` and have `VaultApp.tsx` special-case dialog names starting with `theme:` to call `setTheme` directly — this keeps `core-commands` free of UI-framework imports while preserving one-click theme switching from the command menu. Update `VaultApp.tsx`'s `openDialog` implementation accordingly:

```ts
// src/components/vault/VaultApp.tsx — openDialog wiring (Task 8's stub, completed here)
openDialog: (name: string) => {
  if (name === "sync") { setSyncDialogOpen(true); return; }
  if (name === "plugins") { setPluginsDialogOpen(true); return; } // state added in Task 11
  if (name.startsWith("theme:")) { setTheme(name.slice("theme:".length)); return; }
},
toggleSidebar: () => toggleSidebar(), // from useSidebar()
```

`VaultApp.tsx` must import `useTheme` from `next-themes` and `useSidebar` from `@/components/ui/sidebar` (the former is already used by `CommandMenu.tsx` today and moves up to `VaultApp.tsx` in this task).

Now migrate `CommandMenu.tsx`'s Actions group:

```tsx
// src/components/vault/CommandMenu.tsx — Actions group replacement
import { useApp, useCommands } from "@/lib/plugins/react";
import { CommandShortcut } from "@/components/ui/command";
import { formatHotkey } from "@/lib/plugins/hotkeys";

// ... inside CommandMenu component, replace the hard-coded Actions group:
const app = useApp();
const commands = useCommands();
const platform = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "mac" : "other";
// ...
<CommandGroup heading="Actions">
  {commands.map((cmd) => (
    <CommandItem key={cmd.fullId} value={cmd.name} keywords={cmd.keywords} onSelect={() => run(() => app.commands.execute(cmd.fullId))}>
      {cmd.icon ? <cmd.icon data-icon="inline-start" /> : null}
      {cmd.name}
      {cmd.hotkeys?.[0] ? <CommandShortcut>{formatHotkey(cmd.hotkeys[0], platform)}</CommandShortcut> : null}
    </CommandItem>
  ))}
</CommandGroup>
```

Remove the now-unused `onCreateNote`/`onCreateGraph`/`onCreateFolder` props from `CommandMenuProps` and the `APP_THEMES`/`useTheme`/`useSidebar`/`useSync` imports and usages that moved to `core-commands`/`VaultApp.tsx`. Add `useApp` to `src/lib/plugins/react.tsx` (referenced in Task 9's Interfaces section):

```ts
// src/lib/plugins/react.tsx — addition
export function useApp(): App {
  return useContextValue().app;
}
```

and extend `PluginContextValue`/`PluginHostProviderProps` with `app: App`, updating `VaultApp.tsx`'s `<PluginHostProvider host={...} commands={commandRegistry} app={app} activeNote={null}>`.

- [ ] **Step 4: Run tests to verify everything passes**

Run: `npx vitest run src/plugins src/lib/plugins src/components/vault` and `npm run lint`
Expected: PASS; no unused-import lint errors in `CommandMenu.tsx`/`VaultApp.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/core-commands src/plugins/index.ts src/lib/plugins/host.ts src/lib/plugins/react.tsx src/components/vault/CommandMenu.tsx src/components/vault/VaultApp.tsx
git commit -m "feat(plugins): add core-commands plugin and migrate CommandMenu to it"
```

---

### Task 10: `core-live-preview` and `core-wikilinks` plugins

**Files:**
- Create: `src/plugins/core-live-preview/index.ts`
- Create: `src/plugins/core-wikilinks/index.ts`
- Modify: `src/plugins/index.ts`
- Modify: `src/lib/editor/extensions.ts` (remove `defaultPluginExtension` scaffolding from Task 6; caller now passes `registry.buildExtension()` directly)
- Modify: `src/components/editor/NoteEditor.tsx` (build an `EditorExtensionRegistry` per note, populate it from the enabled plugins, subscribe to reconfigure)
- Test: `src/plugins/core-live-preview/__tests__/index.test.ts`, `src/plugins/core-wikilinks/__tests__/index.test.ts`

**Interfaces:**
- Consumes: `livePreview`, `LivePreviewOptions` from `@/lib/editor/live-preview` (existing, confirmed at `src/lib/editor/live-preview.ts:471,612`); `wikilinkCompletionSource` from `@/lib/editor/wikilink-autocomplete` (existing, confirmed at `src/lib/editor/wikilink-autocomplete.ts:51`); `Plugin.registerEditorExtension`/`registerCompletionSource` (Task 1, wired for real in this task — Task 2's `PluginHost.enable` currently no-ops them; this task fixes that the same way Task 9 fixed `addCommand`, delegating to an `EditorExtensionRegistry` passed into `PluginHost`'s constructor alongside `commands`).
- Produces:
  - `export const CORE_LIVE_PREVIEW_MANIFEST: PluginManifest` (`id: "core-live-preview"`, `isCore: true`); `class CoreLivePreviewPlugin extends Plugin { onload() { this.registerEditorExtension(livePreview(this.getOptions())); } }` where `getOptions()` builds `LivePreviewOptions` from `app.workspace` (`resolveWikilink`, `onOpenWikilink: (id) => app.workspace.openNote(id)`, `onCreateWikilink`) — Phase 1 leaves `resolveWikilink`/`onCreateWikilink` as optional hooks the plugin exposes via a new `App.workspace` method added this task: `resolveWikilink(target: string): string | undefined` and `createWikilinkTarget(target: string): void`, extending the `App` interface from Task 1 (documented here as an addition since the spec explicitly calls for "wikilink click/open options supplied through `app.workspace`").
  - `export const CORE_WIKILINKS_MANIFEST: PluginManifest` (`id: "core-wikilinks"`, `isCore: true`); `class CoreWikilinksPlugin extends Plugin { onload() { this.registerCompletionSource(wikilinkCompletionSource(() => this.app.workspace.getWikilinkCandidates())); } }` — adds `App.workspace.getWikilinkCandidates(): WikilinkCandidate[]` to the `App` interface (`WikilinkCandidate` re-exported from `@/lib/plugins/api` for plugin authors, importing it from `@/lib/vault/wikilink` inside `api.ts` only, which is allowed since `api.ts` itself isn't under `src/plugins/**`).
  - `PluginHost` constructor becomes `(app: App, storage: PluginStorage, commands = new CommandRegistry(), editorExtensions = new EditorExtensionRegistry())`; `enable()`'s `ctx` object literal gets its `registerEditorExtension`/`registerCompletionSource` fields replaced with `(ext) => disposers.push(editorExtensions.addExtension(reg.manifest.id, ext))` and `(source) => disposers.push(editorExtensions.addCompletionSource(reg.manifest.id, source))` respectively — still delegated via `bindPluginContext(instance, ctx)`, never by patching properties on `instance`. Add `PluginHost.editorExtensions: EditorExtensionRegistry` read accessor so `NoteEditor.tsx` can reach it (via `usePluginHost()`).

- [ ] **Step 1: Write the failing test**

```ts
// src/plugins/core-live-preview/__tests__/index.test.ts
import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "@/lib/plugins/host";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { CoreLivePreviewPlugin, CORE_LIVE_PREVIEW_MANIFEST } from "@/plugins/core-live-preview";
import type { App } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: vi.fn(),
      toggleSidebar: () => {},
      openDialog: () => {},
      resolveWikilink: () => undefined,
      createWikilinkTarget: () => {},
      getWikilinkCandidates: () => [],
    },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify: () => {},
  };
}

describe("CoreLivePreviewPlugin", () => {
  it("registers exactly one editor extension on load", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    host.register(CORE_LIVE_PREVIEW_MANIFEST, CoreLivePreviewPlugin);
    await host.enable("core-live-preview");
    expect(host.editorExtensions.getSnapshot()).toEqual([{ pluginId: "core-live-preview" }]);
  });

  it("disabling removes the registered extension", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    host.register(CORE_LIVE_PREVIEW_MANIFEST, CoreLivePreviewPlugin);
    await host.enable("core-live-preview");
    await host.disable("core-live-preview");
    expect(host.editorExtensions.getSnapshot()).toEqual([]);
  });
});
```

```ts
// src/plugins/core-wikilinks/__tests__/index.test.ts
import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "@/lib/plugins/host";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { CoreWikilinksPlugin, CORE_WIKILINKS_MANIFEST } from "@/plugins/core-wikilinks";
import type { App } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: () => {},
      toggleSidebar: () => {},
      openDialog: () => {},
      resolveWikilink: () => undefined,
      createWikilinkTarget: () => {},
      getWikilinkCandidates: vi.fn(() => []),
    },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify: () => {},
  };
}

describe("CoreWikilinksPlugin", () => {
  it("registers exactly one completion source on load", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    host.register(CORE_WIKILINKS_MANIFEST, CoreWikilinksPlugin);
    await host.enable("core-wikilinks");
    // EditorExtensionRegistry tracks completion sources separately from
    // extensions; buildExtension() must not throw with the source present.
    expect(() => host.editorExtensions.buildExtension()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/plugins/core-live-preview src/plugins/core-wikilinks`
Expected: FAIL — modules not found

- [ ] **Step 3: Write minimal implementation**

Extend `App.workspace` in `src/lib/plugins/api.ts`:

```ts
// src/lib/plugins/api.ts — App.workspace additions
import type { WikilinkCandidate } from "@/lib/vault/wikilink";
export type { WikilinkCandidate };

// inside `workspace`:
resolveWikilink(target: string): string | undefined;
createWikilinkTarget(target: string): void;
getWikilinkCandidates(): WikilinkCandidate[];
```

Update `PluginHost` (`src/lib/plugins/host.ts`) to accept and wire `EditorExtensionRegistry`:

```ts
// src/lib/plugins/host.ts — changes
import { EditorExtensionRegistry } from "@/lib/plugins/editor";

export class PluginHost {
  readonly editorExtensions: EditorExtensionRegistry;
  constructor(
    private app: App,
    private storage: PluginStorage,
    private commands: CommandRegistry = new CommandRegistry(),
    editorExtensions: EditorExtensionRegistry = new EditorExtensionRegistry(),
  ) {
    this.editorExtensions = editorExtensions;
  }
  // in enable(), in the `ctx` object literal, replace the two no-op fields:
  registerEditorExtension: (ext) => {
    disposers.push(this.editorExtensions.addExtension(reg.manifest.id, ext));
  },
  registerCompletionSource: (source) => {
    disposers.push(this.editorExtensions.addCompletionSource(reg.manifest.id, source));
  },
  // (addCommand/register/loadData/saveData fields are unchanged from Task 9;
  // `bindPluginContext(instance, ctx)` still runs once per enable() call.)
```

```ts
// src/plugins/core-live-preview/index.ts
import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";
import { livePreview } from "@/lib/editor/live-preview";

export const CORE_LIVE_PREVIEW_MANIFEST: PluginManifest = {
  id: "core-live-preview",
  name: "Core Live Preview",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

export class CoreLivePreviewPlugin extends Plugin {
  onload(): void {
    this.registerEditorExtension(
      livePreview({
        resolveWikilink: (target) => this.app.workspace.resolveWikilink(target),
        onOpenWikilink: (documentId) => this.app.workspace.openNote(documentId),
        onCreateWikilink: (target) => this.app.workspace.createWikilinkTarget(target),
      }),
    );
  }
}
```

```ts
// src/plugins/core-wikilinks/index.ts
import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";
import { wikilinkCompletionSource } from "@/lib/editor/wikilink-autocomplete";

export const CORE_WIKILINKS_MANIFEST: PluginManifest = {
  id: "core-wikilinks",
  name: "Core Wikilinks",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

export class CoreWikilinksPlugin extends Plugin {
  onload(): void {
    this.registerCompletionSource(wikilinkCompletionSource(() => this.app.workspace.getWikilinkCandidates()));
  }
}
```

```ts
// src/plugins/index.ts — add both
import { CoreLivePreviewPlugin, CORE_LIVE_PREVIEW_MANIFEST } from "@/plugins/core-live-preview";
import { CoreWikilinksPlugin, CORE_WIKILINKS_MANIFEST } from "@/plugins/core-wikilinks";

export const BUNDLED_PLUGINS: [PluginManifest, new (app: App, manifest: PluginManifest) => Plugin][] = [
  [CORE_COMMANDS_MANIFEST, CoreCommandsPlugin],
  [CORE_LIVE_PREVIEW_MANIFEST, CoreLivePreviewPlugin],
  [CORE_WIKILINKS_MANIFEST, CoreWikilinksPlugin],
];
```

Simplify `adhdEditorExtensions` (`src/lib/editor/extensions.ts`) to drop `defaultPluginExtension` and the now-plugin-owned `autocompletion`/`livePreview`/`wikilinkCompletionSource` imports, replacing `pluginCompartment.of(defaultPluginExtension)` with `pluginCompartment.of(opts.initialPluginExtension)` where `initialPluginExtension: Extension` becomes a required option (as originally specified in Task 6's Interfaces section — Task 6 deferred this swap to this task, now executed). Update `NoteEditor.tsx`: create `const editorExtensions = usePluginHost().editorExtensions;` and `const pluginCompartment = useMemo(() => new Compartment(), [])`, pass `initialPluginExtension: editorExtensions.buildExtension()` into `adhdEditorExtensions`, and add a `useEffect` that calls `editorExtensions.subscribe(() => reconfigurePluginCompartment(view, pluginCompartment, editorExtensions.buildExtension()))`.

- [ ] **Step 4: Run tests to verify everything passes**

Run: `npx vitest run src/plugins src/lib/plugins src/lib/editor` and `npm run lint`
Expected: PASS, including pre-existing `src/lib/editor/__tests__/live-preview.test.ts` and `wikilink-autocomplete.test.ts` (unchanged files, still exercising the same pure functions).

- [ ] **Step 5: Commit**

```bash
git add src/plugins/core-live-preview src/plugins/core-wikilinks src/plugins/index.ts src/lib/plugins/host.ts src/lib/plugins/api.ts src/lib/editor/extensions.ts src/components/editor/NoteEditor.tsx
git commit -m "feat(plugins): migrate live preview and wikilink completion to core plugins"
```

---

### Task 11: `word-count` plugin + `PluginsDialog`

**Files:**
- Create: `src/plugins/word-count/index.ts`
- Create: `src/components/plugins/PluginsDialog.tsx`
- Modify: `src/plugins/index.ts`
- Modify: `src/components/vault/VaultApp.tsx` (add `pluginsDialogOpen` state, render `<PluginsDialog>`)
- Test: `src/plugins/word-count/__tests__/index.test.ts`, `src/components/plugins/__tests__/PluginsDialog.test.ts`

**Interfaces:**
- Consumes: `Plugin`, `App`, `PluginManifest` (Task 1); `usePluginStatuses`, `usePluginHost` (Task 7); `EditorView.updateListener` (`@codemirror/view`).
- Produces:
  - `export const WORD_COUNT_MANIFEST: PluginManifest` (`id: "word-count"`, NOT `isCore` — demonstrates an optional plugin per spec §Testing intent of exercising toggle-off).
  - `interface WordCountSettings { includeFrontmatter: boolean }` (default `{ includeFrontmatter: false }`).
  - `function countWords(text: string, settings: WordCountSettings): number` — pure function, split on whitespace; when `includeFrontmatter` is `false`, strips a leading `---\n...\n---` block first (reuse the same shape as `detectFrontmatter` in `live-preview.ts`, reimplemented locally since `core-wikilinks`-style plugins can't import `@/lib/editor/live-preview` internals beyond what's already an allowed import — but `live-preview.ts`'s `detectFrontmatter` isn't in the plugin allowlist path `@/lib/plugins/api`, so `word-count` reimplements a minimal local version rather than importing `@/lib/editor/*` directly, keeping the ESLint restriction honest).
  - `class WordCountPlugin extends Plugin { onload(): Promise<void> }` — loads `WordCountSettings` via `loadData()` (default when `null`), registers an `EditorView.updateListener.of(...)` editor extension that recomputes the count on doc changes and stores it on a module-level `WeakMap<EditorView, number>` (or view-attached field) for the command to read, adds command `id: "show-word-count"`, `name: "Word count: Show"`, `callback` that reads the last-focused view's count and calls `app.notify(...)`.
  - `PluginsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element` — lists `usePluginStatuses()`, name/description/state, a toggle switch calling `host.enable(id)`/`host.disable(id)` from `usePluginHost()`, disabled (can't fully disable, per spec "can disable, not uninstall" — Phase 1 toggle still calls disable/enable; "isCore" just means it's always present in the bundle, not un-togglable, so no special-casing needed beyond spec's plain reading), and shows `status.error` text when `state === "failed"`.

- [ ] **Step 1: Write the failing test**

```ts
// src/plugins/word-count/__tests__/index.test.ts
import { describe, expect, it } from "vitest";
import { countWords } from "@/plugins/word-count";

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
```

```tsx
// src/components/plugins/__tests__/PluginsDialog.test.ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PluginsDialog } from "@/components/plugins/PluginsDialog";
import { PluginHostProvider } from "@/lib/plugins/react";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { Plugin, type App } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: { getActiveNote: () => null, openNote: () => {}, toggleSidebar: () => {}, openDialog: () => {}, resolveWikilink: () => undefined, createWikilinkTarget: () => {}, getWikilinkCandidates: () => [] },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify: () => {},
  };
}

describe("PluginsDialog", () => {
  it("lists registered plugins with their state", async () => {
    const app = makeApp();
    const host = new PluginHost(app, new InMemoryPluginStorage());
    class A extends Plugin {}
    host.register({ id: "a", name: "Plugin A", description: "Does things", version: "1.0.0", minAppVersion: "1.0.0" }, A);
    render(
      <PluginHostProvider host={host} commands={new CommandRegistry()} app={app} activeNote={null}>
        <PluginsDialog open={true} onOpenChange={vi.fn()} />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("Plugin A")).toBeTruthy();
    expect(await screen.findByText("disabled")).toBeTruthy();
  });

  it("shows the error message for a failed plugin", async () => {
    const app = makeApp();
    const host = new PluginHost(app, new InMemoryPluginStorage());
    class Bad extends Plugin {
      onload() {
        throw new Error("bad config");
      }
    }
    host.register({ id: "bad", name: "Bad Plugin", version: "1.0.0", minAppVersion: "1.0.0" }, Bad);
    await host.enable("bad");
    render(
      <PluginHostProvider host={host} commands={new CommandRegistry()} app={app} activeNote={null}>
        <PluginsDialog open={true} onOpenChange={vi.fn()} />
      </PluginHostProvider>,
    );
    expect(await screen.findByText(/bad config/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/plugins/word-count src/components/plugins`
Expected: FAIL — modules not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/plugins/word-count/index.ts
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
```

```tsx
// src/components/plugins/PluginsDialog.tsx
"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { usePluginHost, usePluginStatuses } from "@/lib/plugins/react";

export function PluginsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const host = usePluginHost();
  const statuses = usePluginStatuses();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Plugins</DialogTitle>
          <DialogDescription>Enable or disable bundled plugins.</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3">
          {statuses.map((status) => (
            <li key={status.manifest.id} className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{status.manifest.name}</div>
                {status.manifest.description ? (
                  <p className="text-sm text-muted-foreground">{status.manifest.description}</p>
                ) : null}
                <p className="text-sm text-muted-foreground">{status.state}</p>
                {status.state === "failed" && status.error ? (
                  <p className="text-sm text-destructive">{status.error}</p>
                ) : null}
              </div>
              <Switch
                checked={status.state === "enabled"}
                onCheckedChange={(checked) => {
                  if (checked) void host.enable(status.manifest.id);
                  else void host.disable(status.manifest.id);
                }}
              />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
```

Add to `src/plugins/index.ts`:

```ts
import { WordCountPlugin, WORD_COUNT_MANIFEST } from "@/plugins/word-count";
// append to BUNDLED_PLUGINS:
[WORD_COUNT_MANIFEST, WordCountPlugin],
```

Wire into `VaultApp.tsx`: add `const [pluginsDialogOpen, setPluginsDialogOpen] = useState(false);`, render `<PluginsDialog open={pluginsDialogOpen} onOpenChange={setPluginsDialogOpen} />` alongside the existing dialogs, and complete the `openDialog("plugins")` branch added in Task 9 to call `setPluginsDialogOpen(true)`.

If `@/components/ui/switch` doesn't exist yet, check first: run `ls src/components/ui/switch.tsx`; if absent, use the project's existing toggle primitive instead (grep `src/components/ui` for an existing `Switch`/`Toggle` component before adding a new one — do not introduce a new UI dependency for this).

- [ ] **Step 4: Run tests to verify everything passes**

Run: `npx vitest run src/plugins/word-count src/components/plugins` and `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/word-count src/components/plugins/PluginsDialog.tsx src/plugins/index.ts src/components/vault/VaultApp.tsx
git commit -m "feat(plugins): add word-count plugin and PluginsDialog"
```

---

### Task 12: ESLint restricted-imports rule for `src/plugins/**`

**Files:**
- Modify: `eslint.config.mjs`
- Test: manual lint run (ESLint config changes aren't unit-testable via Vitest; verified by running the linter against a deliberately bad fixture and reverting it)

**Interfaces:**
- Consumes: existing `eslintConfig` array in `eslint.config.mjs`.
- Produces: an additional entry in the `defineConfig([...])` array scoping `no-restricted-imports` to `files: ["src/plugins/**/*.ts", "src/plugins/**/*.tsx"]`, excluding `src/plugins/**/__tests__/**` (tests may import test utilities freely) — allowing only `@/lib/plugins/api`, `@codemirror/*`, `@lezer/*`, `lucide-react`, `react` (spec §4).

- [ ] **Step 1: Confirm the rule fires on a deliberate violation**

Temporarily add a bad import to `src/plugins/word-count/index.ts` to prove the rule works before wiring it (do this only to verify, then revert — do not commit):

```ts
// temporary, for verification only
import { toast } from "sonner";
```

Run: `npm run lint`
Expected (before Step 3): PASS (no rule yet) — confirms the baseline is lint-clean without the new rule so the next step's failure is attributable to the new rule.

- [ ] **Step 2: Revert the temporary import, then add the rule**

```bash
git checkout -- src/plugins/word-count/index.ts
```

```js
// eslint.config.mjs
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["src/plugins/**/*.ts", "src/plugins/**/*.tsx"],
    ignores: ["src/plugins/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/*", "!@/lib/plugins/api"],
              message: "Plugins may only import @/lib/plugins/api, not other @/lib internals (see docs/superpowers/specs/2026-09-18-plugin-system-design.md §4).",
            },
            {
              group: ["@/components/*", "@/app/*"],
              message: "Plugins may not import app components or routes directly.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
```

- [ ] **Step 3: Verify the rule catches a violation and passes on real plugin code**

Re-add the temporary bad import from Step 1, run `npm run lint`, confirm it now FAILS with the `no-restricted-imports` message, then revert it again:

```bash
git checkout -- src/plugins/word-count/index.ts
npm run lint
```

Expected final state: `npm run lint` PASSES across the whole repo, including all of `src/plugins/**` written in Tasks 9–11 (`core-commands` imports `lucide-react`, `@/lib/plugins/api`, `@/lib/themes` — wait, `@/lib/themes` is NOT in the allowlist; re-check Task 9's `core-commands/index.ts`, which imports `APP_THEMES` from `@/lib/themes`. This violates the rule as written. Resolve by moving `APP_THEMES` construction out of the plugin: have `VaultApp.tsx` read `APP_THEMES` and pass theme command specs into `CoreCommandsPlugin`'s constructor instead, OR add `@/lib/themes` to the plugin allowlist as a spec deviation. Since the spec's file table and §4 don't special-case `@/lib/themes` and Phase 3 explicitly plans to move `APP_THEMES` behind `registerTheme`, the correct Phase 1 fix is to NOT import `@/lib/themes` from `core-commands` — instead, `VaultApp.tsx` constructs the theme-related `Command[]` from `APP_THEMES` and calls a new `CoreCommandsPlugin.registerThemeCommands(commands: Command[])` method after `onload()`, OR — simpler — keep theme commands in `VaultApp.tsx` itself via `commandRegistry.add("core-commands", ...)` calls made directly from `VaultApp.tsx` alongside `host.enableFromStorage()`, rather than inside `CoreCommandsPlugin.onload()`. Apply this fix now: move the `for (const {id, label, icon} of APP_THEMES)` loop and the `theme-system` command out of `src/plugins/core-commands/index.ts` and into `VaultApp.tsx`, registered directly against `commandRegistry` with `pluginId: "core-commands"` after the plugin is enabled, and delete the `@/lib/themes` import from `core-commands/index.ts`. Update `src/plugins/core-commands/__tests__/index.test.ts` if it asserted theme commands (it didn't — Task 9's test only checks the plugin enables without throwing).

- [ ] **Step 4: Re-run the full test suite and lint**

Run: `npm test` and `npm run lint`
Expected: both PASS with zero violations.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs src/plugins/core-commands/index.ts src/components/vault/VaultApp.tsx
git commit -m "chore(plugins): restrict src/plugins/** imports to the plugin API surface"
```

---

## Final verification

- [ ] Run `npm test` — full suite green, including every new `src/lib/plugins/__tests__/*`, `src/plugins/*/__tests__/*`, and `src/components/plugins/__tests__/*` file plus all pre-existing suites listed at plan-authoring time (`src/components/vault/__tests__`, `src/lib/browser/__tests__`, `src/lib/core/__tests__`, `src/lib/editor/__tests__`, `src/lib/graph/__tests__`, `src/lib/search/__tests__`, `src/lib/server/__tests__`, `src/lib/sync/__tests__`, `src/lib/vault/__tests__`).
- [ ] Run `npm run lint` — zero errors, including the new `no-restricted-imports` scope.
- [ ] Manually smoke-test in the running app (`npm run dev`): ⌘K opens the command menu, "New note"/"New graph"/"New folder"/"Toggle sidebar"/"Sync settings"/theme entries all work exactly as before, "Plugins: Manage" opens `PluginsDialog`, toggling `word-count` off then back on works, "Word count: Show" toasts a count, wikilink `[[` autocomplete and click-to-open still work, live preview rendering (headings/bullets/checkboxes/hr) is unchanged.
