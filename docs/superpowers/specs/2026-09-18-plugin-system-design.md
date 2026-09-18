# Plugin System — Design

Date: 2026-09-18
Status: Approved (Phase 1 in scope)

## Goal

Give Methyl an Obsidian-style plugin architecture. Initially only first-party
plugins ship (bundled with the app), but the API, storage layout and
boundaries are designed so community plugins can be added later without
reworking plugin code or core.

## Non-goals (Phase 1)

- Loading third-party code from disk or network.
- Sandboxing (iframe/worker isolation).
- UI slots, vault events, markdown post-processors, graph extensions, theme
  registration (later phases, see Phasing).
- Hotkey-editing UI (data format is fixed now; UI later).

## Architecture overview

- `PluginHost` owns plugin lifecycle and a registry per extension point.
- Plugins subclass `Plugin` and register contributions in `onload()`.
  Every registration returns/records a disposer; unloading runs them.
- Plugins reach the app only through the injected `app: App` object and types
  re-exported from `@/lib/plugins/api`. They never import `@/lib/*` internals.
- React consumes registries via `useSyncExternalStore`.
- The CodeMirror editor consumes plugin extensions through one `Compartment`,
  reconfigured live on registry change.

### Files

| Path | Purpose |
| --- | --- |
| `src/lib/plugins/api.ts` | Public surface: `Plugin`, `App`, `Command`, `Hotkey`, `NoteContext`, `PluginManifest`, `API_VERSION` |
| `src/lib/plugins/host.ts` | `PluginHost`: register/enable/disable, rollback on failure, persistence of enabled set |
| `src/lib/plugins/commands.ts` | `CommandRegistry` |
| `src/lib/plugins/hotkeys.ts` | `HotkeyManager` + `Mod` normalisation + user overrides |
| `src/lib/plugins/editor.ts` | `EditorExtensionRegistry`, completion source registry, compartment helpers |
| `src/lib/plugins/react.ts` | `usePluginHost`, `useCommands` hooks, context provider |
| `src/plugins/<id>/index.ts` | Bundled plugins (`core-commands`, `core-live-preview`, `core-wikilinks`, `word-count`) |
| `src/plugins/index.ts` | Bundled plugin list |
| `src/components/plugins/PluginsDialog.tsx` | Minimal enable/disable list |

## 1. Lifecycle and manifest

```ts
interface PluginManifest {
  id: string;            // kebab-case, unique
  name: string;
  version: string;       // semver
  minAppVersion: string;
  description?: string;
  author?: string;
  isCore?: boolean;      // bundled first-party; can disable, not uninstall
}

abstract class Plugin {
  constructor(readonly app: App, readonly manifest: PluginManifest) {}
  onload(): void | Promise<void>;
  onunload(): void;
  addCommand(cmd: Command): Command;
  registerEditorExtension(ext: Extension | Extension[]): void;
  registerCompletionSource(source: CompletionSource): void;
  register(dispose: () => void): void;
  loadData<T>(): Promise<T | null>;
  saveData(data: unknown): Promise<void>;
}
```

`PluginHost`:

- `register(manifest, PluginClass)` — records availability.
- `enable(id)` — checks `minAppVersion` against `API_VERSION`, instantiates,
  awaits `onload`, stores disposers. On throw: runs disposers recorded so far
  (reverse order), logs with plugin id, marks state `failed`, continues.
- `disable(id)` — `onunload()`, then disposers in reverse order; state `disabled`.
- States: `disabled | enabled | failed`. Subscribable for the UI.

Storage (inside the vault so it syncs; never inside `.md` files):

- `.adhd/plugins.json` — `{ "enabled": string[] }`. Absent ⇒ all `isCore`
  plugins enabled.
- `.adhd/plugins/<id>/data.json` — `loadData`/`saveData`.
- `.adhd/plugins/<id>/{manifest.json,main.js}` — reserved for Phase 4.

Boot: `VaultApp` constructs `App` + `PluginHost` once the vault is open,
registers bundled plugins from `src/plugins/index.ts`, enables per
`plugins.json`. Host is provided through React context.

`App` (Phase 1 surface):

- `app.commands` — `CommandRegistry` public methods.
- `app.workspace` — `getActiveNote(): NoteContext | null`, editor registries,
  `openNote(id)`, `toggleSidebar()`, `openDialog(name)` for the actions core
  commands need.
- `app.vault` — thin wrapper: `createNote`, `createGraph`, `createFolder`,
  `read(id)`, `list()`. Grows in Phase 2.
- `app.notify(message, kind?)` — toast.

## 2. Commands and hotkeys

```ts
interface Hotkey { modifiers: ("Mod" | "Ctrl" | "Alt" | "Shift" | "Meta")[]; key: string }

interface Command {
  id: string;            // plugin-local; stored as `${pluginId}:${id}`
  name: string;
  icon?: LucideIcon;
  keywords?: string[];
  hotkeys?: Hotkey[];
  // exactly one of:
  callback?: () => void | Promise<void>;
  checkCallback?: (checking: boolean) => boolean;
  editorCallback?: (editor: EditorView, ctx: NoteContext) => void;
}
```

`CommandRegistry`:

- `add(pluginId, cmd)` → disposer; throws on duplicate full id.
- `list()` — available now: excludes `checkCallback(true) === false` and
  `editorCallback` commands without a focused note.
- `execute(fullId)` — catches sync/async errors, shows toast via `app.notify`.
- `subscribe` / `getSnapshot` for `useSyncExternalStore`.

`CommandMenu`:

- Actions group renders `useCommands()` instead of hard-coded items.
- Shows hotkeys via `CommandShortcut`.
- Recently used (last 5, per device, `localStorage`, try/catch-guarded) sorted
  first.
- Notes group unchanged.

`HotkeyManager`:

- One `window` `keydown` listener for global commands; `Mod` = ⌘ on macOS,
  Ctrl elsewhere.
- `editorCallback` commands bound via a CodeMirror keymap inside the plugin
  compartment.
- Effective bindings = defaults overridden per command by
  `.adhd/hotkeys.json` (`{ "<fullId>": Hotkey[] }`; `[]` unbinds).
- Conflicts: last registered wins, `console.warn`.
- ⌘K stays hard-wired in core; plugins cannot override it.

Migration: current actions (new note, new graph, new folder, toggle sidebar,
sync settings) move into `core-commands`. Theme commands stay generated from
`APP_THEMES` in core until Phase 3's `registerTheme`.

## 3. Editor extensions

- `EditorExtensionRegistry`: list of `{ pluginId, ext }` + subscribe.
- `adhdEditorExtensions()` keeps non-optional core: Loro sync/undo/presence,
  base keymap, markdown language, theme, single `autocompletion()`.
- Adds `pluginCompartment` initialised with `registry.all()` plus the
  editor-command keymap. On registry change, each open view dispatches
  `pluginCompartment.reconfigure(...)` — no view recreation, cursor and undo
  preserved.
- Precedence: Loro bindings sit outside and before the compartment. Plugins
  use `Prec.*` themselves when ordering matters.
- Completion: core owns one `autocompletion({ override: merged })`, where
  `merged` calls every registered source, each wrapped in try/catch
  (failing source returns `null`). Wikilink completion migrates to this.
- Errors: `EditorView.exceptionSink` handler attributes the exception to a
  plugin when possible (via registered-extension tagging), logs, and disables
  that plugin. Unattributable errors are logged only.

Migrations and new plugins:

- `core-live-preview` — wraps existing `livePreview()` (including wikilink
  click/open options supplied through `app.workspace`).
- `core-wikilinks` — completion source from `wikilink-autocomplete.ts`.
- `word-count` — new; editor extension tracks count, command "Word count: Show"
  toasts it, `saveData` stores `{ includeFrontmatter: boolean }`-style
  settings to exercise persistence.

Settings › Plugins (Phase 1): `PluginsDialog` opened by command
"Plugins: Manage" — list with name, description, state, toggle. `failed`
state shows the error message.

## 4. Future-proofing rules

- ESLint `no-restricted-imports` on `src/plugins/**`: only
  `@/lib/plugins/api`, `@codemirror/*`, `@lezer/*`, `lucide-react`, `react`.
- Every registration is disposable.
- No plugin data in `.md` files.
- `API_VERSION` exported; `minAppVersion` checked at enable time.

## Phasing

1. **Phase 1 (this spec)** — host, commands, hotkeys, editor extensions,
   migrations above, PluginsDialog.
2. **Phase 2** — vault events (`create | modify | rename | delete`), markdown
   post-processors and code-block renderers.
3. **Phase 3** — UI slots (sidebar views, status bar, ribbon, settings tabs),
   `registerTheme` (move `APP_THEMES`), graph node types and context actions.
4. **Phase 4** — community plugins: load from `.adhd/plugins/<id>/`,
   restricted-mode toggle + warning, optional iframe/worker isolation reusing
   the `App` interface.

## Testing (vitest, TDD)

- Host: enable/disable, reverse-order disposal, `onload` throw rolls back
  partial registrations and marks `failed`, `minAppVersion` rejection,
  `plugins.json` default and persistence.
- `CommandRegistry`: namespacing, duplicate id rejection, `checkCallback` and
  `editorCallback` filtering, error → toast.
- `HotkeyManager`: `Mod` mapping per platform, user override beats default,
  `[]` unbinds, conflict warning.
- Editor: headless `EditorView`; enabling/disabling a plugin adds/removes its
  extension while document and undo state persist; merged completion sources
  with one throwing source.
- Existing editor and CommandMenu tests stay green after migration.
