# Workspace, Quick Switcher, and Attachments Implementation Plan

> **Execution profile:** Give this whole plan to one `gpt-5.6-luna` agent with `reasoning_effort: max`.
>
> **Required order:** (2) tabs and split panes, then (1) Quick Switcher, then (3) attachments and embeds. Do not reorder phases.

**Goal:** Add an Obsidian-style workspace to Methyl, add a dedicated note Quick Switcher, then add portable attachments with inline embeds and complete offline/sync behavior.

**Architecture:** Put workspace behavior behind one deep `WorkspaceStore` interface. React renders its serializable pane tree but does not own navigation rules. Keep workspace layout in versioned device-local storage, never Markdown or vault CRDT state. Preserve Methyl's existing URL as a deep link to only the focused note. Add a separate Quick Switcher over title/path/recent-note data without removing full-text search from the existing command palette. Put binary lifecycle behind one deep `VaultAssets` module: tree metadata identifies each asset, ordinary files remain portable truth, reads/writes stream through adapters, and sync addresses assets by stable tree node ID rather than path.

**Current baseline:**

- `VaultApp` owns one `activeId` and mounts one `NoteEditor` or `GraphEditor`.
- `CommandMenu` combines full-text note search and registered commands under `Cmd/Ctrl+K`.
- `VaultTree` already supports `kind: "binary"` nodes and stores `sha256`, but `VaultTreeNode` does not expose binary metadata and no UI creates or renders these nodes.
- `SyncCoordinator` and the server contain partial binary-transfer scaffolding. It can upload bytes but cannot download missing assets, durably journal local asset changes, materialize server assets into the normal vault, or resolve binary conflicts.
- `reconcileMaterialization()` protects tracked binary paths but can remove untracked non-Markdown files. Close this safety gap before importing attachments.
- `react-resizable-panels`, `dnd-kit`, CodeMirror 6, MiniSearch, `@noble/hashes`, Vitest, and Playwright are already installed.

## Global constraints

- Read `AGENTS.md` before work. Before changing Next.js client/lazy-loading behavior, read:
  - `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
  - `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`
  - `node_modules/next/dist/docs/01-app/02-guides/single-page-applications.md`
- Preserve plain Markdown and ordinary files as portable truth. Never add Methyl IDs or attachment metadata to Markdown/frontmatter.
- Keep Loro/CodeMirror browser-only modules out of the SSR graph. Preserve existing dynamic imports around WASM/browser code.
- Distinguish **workspace tabs** from browser tabs in names and comments. Browser tabs still obey the single-writer Web Lock.
- Workspace layout is device-local UI state. Do not sync it through the vault tree or write it under a note.
- The focused pane defines `App.workspace.getActiveNote()`, the active editor view, breadcrumb, backlinks, URL, save badge, and command target.
- Never discard an editor change while switching, closing, moving, or restoring tabs. Existing CRDT text stays authoritative.
- Binary bytes never enter LoroText. Tree nodes carry identity/path metadata; HTTP transfers carry bytes.
- Never load arbitrary large assets fully into JS memory for hashing, upload, download, or persistence. Use `Blob.stream()`, OPFS writable streams, and Node streams.
- Never identify an asset on the sync API by a path. Use the stable tree node ID.
- Never use last-write-wins for conflicting binary edits. Preserve both versions.
- Unknown ordinary files must never be deleted merely because Methyl has not indexed them yet.
- Use existing shadcn/Base UI primitives where suitable. Keep all mobile targets at least 44×44 CSS pixels.
- Add no new state library. `useSyncExternalStore` plus the deep store interfaces are enough.
- Do not add preview-tab/pinning semantics during this plan. Every workspace tab is durable until replaced or closed.
- Keep `Cmd/Ctrl+K` full-text search and commands working. Quick Switcher gets `Cmd/Ctrl+O`.
- Write tests through module interfaces. Replace superseded binary-sync tests; do not layer tests around obsolete stubs.
- Use Conventional Commits. Commit only current-task files, never add a `Co-authored-by` trailer, never use `--no-verify`, and push after each passing task or tightly coupled pair.

## Product contract

### Workspace navigation

- A workspace contains one or more panes arranged as a binary split tree.
- Each pane contains ordered tabs and exactly one active tab.
- A tab holds either no resource, a Markdown document ID, or later an asset tree node ID. Store IDs only; derive names/icons from live vault state.
- Normal open replaces the focused tab. Explicit “open in new tab” creates a tab.
- If the same resource is already open anywhere, focus that tab instead of creating a duplicate. This avoids two independent graph editors mutating one graph document.
- Splitting right or down creates and focuses an empty pane. It does not duplicate the current resource.
- Closing a pane promotes its sibling into the removed split position. Closing the final tab leaves one empty tab.
- Desktop renders all panes with resizable separators. Mobile renders one focused pane and provides a pane chooser when hidden panes exist; split commands are unavailable on mobile.
- Restore tabs, splits, active pane, active tabs, sizes, and recent notes after reload. Prune references to deleted resources.
- The URL mirrors only the focused Markdown note. A URL deep link replaces the focused tab after workspace restoration.

### Quick Switcher

- `Cmd/Ctrl+O` opens a note-only switcher.
- Empty query shows most-recently-focused notes, followed by remaining notes.
- Query ranking favors exact title, title prefix, title token match, then path/fuzzy match. Body content does not affect Quick Switcher ranking.
- Results show title and disambiguating path. Duplicate filenames remain distinguishable.
- `Enter` opens in the focused tab. `Cmd/Ctrl+Enter` opens in a new workspace tab.
- When the query is a valid filename and no exact title/path exists, show `Create “…”`; create the note at vault root with normal auto-suffix behavior.
- The existing sidebar Search action and `Cmd/Ctrl+K` retain full-text body search.

### Attachments and embeds

- Paste, drop, or choose one or more files while editing a note.
- Initial placement is a root `Attachments/` folder. Attachment-location settings are outside this plan.
- Use standard portable Markdown:
  - images: `![filename](relative/path)`
  - other files: `[filename](relative/path)`
- Encode Markdown URL path segments safely while preserving `/`. Resolve relative paths against the note's folder and reject paths escaping the vault.
- Name collisions use existing `name`, `name 2`, `name 3` behavior.
- Image attachments render inline when the selection is outside their Markdown syntax. Selection reveals source Markdown.
- The sidebar shows binary files. Opening one creates an asset workspace tab with an image/audio/video/PDF preview when supported and a generic download view otherwise.
- Asset object URLs are reference-counted and revoked when no viewer/widget uses them.
- New devices download every tree-listed asset for complete offline availability.
- Server vaults materialize attachments at normal tree paths, not only under `.adhd`.

## Target module seams

### `WorkspaceStore`

Create `src/lib/workspace/store.ts`. Export state types plus one observable class:

```ts
type WorkspaceResource =
  | { kind: "document"; documentId: string }
  | { kind: "asset"; treeId: string };

type WorkspaceTab = {
  id: string;
  resource: WorkspaceResource | null;
};

type WorkspaceNode =
  | { kind: "pane"; id: string; tabs: WorkspaceTab[]; activeTabId: string }
  | {
      kind: "split";
      id: string;
      direction: "horizontal" | "vertical";
      children: [WorkspaceNode, WorkspaceNode];
      sizes: [number, number];
    };

type WorkspaceSnapshot = {
  version: 1;
  root: WorkspaceNode;
  focusedPaneId: string;
  recentDocumentIds: string[];
};
```

Required interface:

- `getSnapshot()` and `subscribe(listener)` for React.
- `open(resource, { mode, paneId? })`, where mode is `replace | new-tab`.
- `newTab(paneId?)`, `closeTab(paneId, tabId)`, `focusTab(paneId, tabId)`.
- `split(paneId, direction)`, `closePane(paneId)`, `focusPane(paneId)`.
- `moveTab(tabId, fromPaneId, toPaneId, index)` and `setSplitSizes(splitId, sizes)`.
- `prune(isValidResource)` after vault load/tree refresh.
- `replaceFromDeepLink(documentId)` for initial URL restoration.
- `getFocusedPane()`, `getFocusedTab()`, and `recentDocumentIds()` convenience reads.

The store enforces all invariants internally. React must never mutate the tree directly.

### `ActiveEditorRegistry`

Create `src/lib/workspace/editor-registry.ts` as an ephemeral, non-persisted map from workspace tab ID to `EditorView`. The focused workspace tab selects the active editor. Registration/unregistration must be identity-safe so unmounting one editor cannot clear a newer editor view.

### `VaultAssets`

Create `src/lib/vault/assets.ts`. Its interface owns import, path resolution, metadata, byte verification, materialization, and conflicts:

- `importForNote(documentId, input): Promise<AssetRef>`
- `open(treeId): Promise<Blob | null>`
- `resolveFromNote(documentId, markdownTarget): Promise<AssetRef | null>`
- `writeDownloaded(treeId, blob, expectedHash): Promise<void>`
- `rename(treeId, name)`, `move(treeId, parent, index)`, `delete(treeId)`
- folder-mutation helpers used by `VaultEngine` so binary paths move/delete with their parent folders
- `reconcileExternalFiles(): Promise<AssetIngestReport>`

Use a small `AssetStore` interface in `src/lib/vault/asset-store.ts` with OPFS, Node, and memory adapters. The interface includes lazy `Blob`/stream reads, atomic streamed writes, move, remove, existence/stat, and path listing. UI and sync call `VaultAssets`, not adapters directly.

## Phase 1 — Tabs and split panes

### Task 1: Pure workspace state and invariants

**Files:**

- Create: `src/lib/workspace/store.ts`
- Create: `src/lib/workspace/__tests__/store.test.ts`

- [ ] Implement the state types and `WorkspaceStore` interface above.
- [ ] Inject an ID factory for deterministic tests; production defaults to `crypto.randomUUID()`.
- [ ] Start with one pane containing one empty tab.
- [ ] Make every mutation normalize state: valid focused pane, one active tab per pane, no empty tab arrays, positive split sizes normalized to 100.
- [ ] `open(..., replace)` replaces the focused active tab. `open(..., new-tab)` appends and focuses a tab.
- [ ] If a resource already exists anywhere, focus it and make no duplicate.
- [ ] Splits create a second empty pane and focus it.
- [ ] Closing a final pane is impossible; it becomes one empty pane.
- [ ] Moving the last tab out of a pane inserts an empty tab.
- [ ] Document focus updates an MRU list, deduplicated and capped at 50.
- [ ] `prune` removes missing resources and recent IDs while preserving workspace invariants.
- [ ] Test every rule, including malformed split sizes and repeated commands.

**Verification:**

```bash
npx vitest run src/lib/workspace/__tests__/store.test.ts
npm run check:type
```

**Commit:** `feat(workspace): add pane and tab state model`

### Task 2: Versioned workspace persistence

**Files:**

- Create: `src/lib/workspace/storage.ts`
- Create: `src/lib/workspace/__tests__/storage.test.ts`
- Modify: `src/lib/workspace/store.ts`

- [ ] Add a `WorkspaceStorage` seam with localStorage and memory adapters.
- [ ] Use key `methyl.workspace.v1:<vaultId>`.
- [ ] Validate parsed JSON structurally. Never trust arbitrary persisted IDs, node kinds, sizes, or arrays.
- [ ] Corrupt/unknown versions fall back to a fresh workspace without deleting the bad value until a valid state is saved.
- [ ] Debounce writes. Flush on `pagehide` and `visibilitychange` hidden.
- [ ] Persist IDs/layout/recents only. Never persist titles, editor text, `EditorView`, save state, dialogs, or object URLs.
- [ ] Add load/save/invalid-data tests.

**Verification:**

```bash
npx vitest run src/lib/workspace/__tests__/store.test.ts src/lib/workspace/__tests__/storage.test.ts
```

**Commit:** `feat(workspace): persist local workspace layout`

### Task 3: Active editor registration for multiple panes

**Files:**

- Create: `src/lib/workspace/editor-registry.ts`
- Create: `src/lib/workspace/__tests__/editor-registry.test.ts`
- Modify: `src/components/editor/NoteEditor.tsx`
- Modify: `src/lib/plugins/api.ts`
- Modify: `src/components/vault/VaultApp.tsx`
- Modify tests under `src/components/editor/__tests__` and `src/lib/plugins/__tests__`

- [ ] Register each mounted CodeMirror view under its workspace tab ID.
- [ ] Add `workspaceTabId` and focus callback props to `NoteEditor`.
- [ ] Focus within CodeMirror focuses its pane/tab before command dispatch.
- [ ] Make plugin `getActiveEditorView()` read the registry using focused tab ID.
- [ ] Remove mount-order-dependent “last editor wins” behavior.
- [ ] Unregister only when `(tabId, view)` still matches the registered pair.
- [ ] Focused graph/empty/asset tabs return no editor view.
- [ ] Keep the existing editor initialization identity stable; switching focus must not recreate CodeMirror.
- [ ] Test two mounted editors, focus changes, stale unmount, and plugin editor-command targeting.

**Verification:**

```bash
npx vitest run src/lib/workspace/__tests__/editor-registry.test.ts src/components/editor/__tests__/NoteEditor.stability.test.tsx src/lib/plugins/__tests__
```

**Commit:** `refactor(editor): target commands at focused workspace editor`

### Task 4: Workspace tab and split UI

**Files:**

- Create: `src/components/workspace/WorkspaceView.tsx`
- Create: `src/components/workspace/WorkspaceTabs.tsx`
- Create: `src/components/workspace/__tests__/WorkspaceView.test.tsx`
- Reuse/modify: `src/components/ui/resizable.tsx` only if required by installed `react-resizable-panels` version

- [ ] Render `WorkspaceNode` recursively using `ResizablePanelGroup`, `ResizablePanel`, and `ResizableHandle`.
- [ ] Convert stored direction to the primitive's orientation exactly once in the recursive renderer.
- [ ] Persist separator sizes only at drag completion, not each pointer move.
- [ ] Build accessible tablist semantics: selected state, roving keyboard focus, Left/Right navigation, `Home`, `End`, and named close buttons.
- [ ] Add new-tab and close controls. Keep desktop tabs compact and mobile controls at least 44×44.
- [ ] Add tab DnD reorder and cross-pane move with a separate `DndContext` from the sidebar.
- [ ] Do not nest an interactive close button inside another button. Use a valid tab/close DOM structure.
- [ ] Highlight the focused pane without heavy permanent borders.
- [ ] Mobile: render only the focused pane. Add a pane chooser listing each hidden pane by active resource title or `Empty pane`.
- [ ] Hide split actions on mobile but preserve the desktop split tree in storage.
- [ ] Test recursive rendering, resize callback, keyboard tabs, close/new controls, DnD pure placement, and mobile pane selection.

**Verification:**

```bash
npx vitest run src/components/workspace/__tests__/WorkspaceView.test.tsx
```

**Commit:** `feat(workspace): render tabs and resizable split panes`

### Task 5: Integrate workspace into `VaultApp`

**Files:**

- Modify: `src/components/vault/VaultApp.tsx`
- Modify: `src/components/vault/AppSidebar.tsx`
- Modify: `src/components/vault/BacklinksPanel.tsx`
- Modify: `src/plugins/core-commands/index.ts`
- Modify: `src/lib/plugins/api.ts`
- Add focused integration tests under `src/components/vault/__tests__`

- [ ] Replace `activeId` with a single `WorkspaceStore` instance created per vault ID.
- [ ] Derive focused document/title/save state/backlinks/plugin context from the focused workspace tab.
- [ ] Keep save state per document ID. `Cmd/Ctrl+S` targets only the focused resource.
- [ ] Normal sidebar, backlink, wikilink, create, graph-create, and plugin `openNote()` actions use `replace` mode.
- [ ] Modifier/middle-click and context menu `Open in new tab` use `new-tab` mode.
- [ ] Add `New tab`, `Close tab`, `Next tab`, `Previous tab`, `Split right`, `Split down`, and `Close pane` commands.
- [ ] Suggested defaults: `Mod+T`, `Mod+W`, and `Ctrl+Tab`; leave split commands unbound to avoid platform conflicts.
- [ ] Close every tab referencing a deleted note or deleted folder descendant. Asset pruning arrives in Phase 3.
- [ ] Renames update live labels from tree rows; no workspace-state rewrite required.
- [ ] Remote tree changes call `prune` after rows refresh.
- [ ] Preserve PWA actions (`new`, `new-graph`, `search`, `share`, `open-file`) with the focused pane as target.
- [ ] Keep existing lazy loading for `GraphEditor` and `CommandMenu`.
- [ ] Update the plugin bridge's `getActiveNote`, `openNote`, and editor view lookup without exposing `WorkspaceStore` internals to plugins.

**Commit:** `feat(workspace): integrate multi-pane navigation`

### Task 6: URL restoration and workspace E2E coverage

**Files:**

- Modify: `src/components/vault/VaultApp.tsx`
- Create: `e2e/workspace.spec.ts`
- Modify existing E2E tests only where selectors intentionally changed

- [ ] Restore saved workspace after engine boot, prune invalid resources, then apply a valid URL deep link by replacing the focused tab.
- [ ] Mirror focused Markdown path with `history.replaceState`. Empty, graph, and future asset tabs use `/` unless the graph remains a Markdown document path.
- [ ] Do not add history entries for tab focus changes.
- [ ] E2E: open three notes into tabs, switch, close, and verify active content.
- [ ] E2E: split right and down, open different notes, edit both, resize, reload, and verify content plus layout restore.
- [ ] E2E: drag a tab within and between panes.
- [ ] E2E: delete an open note and a folder containing open notes; stale tabs disappear.
- [ ] E2E: verify `Cmd/Ctrl+S`, backlinks, wikilinks, command actions, and browser writer-lock banner target the focused pane.
- [ ] Mobile E2E: one pane visible, pane chooser reaches hidden panes, tabs and controls meet touch size.

**Verification:**

```bash
npx playwright test e2e/workspace.spec.ts e2e/mobile-quality.spec.ts e2e/backlinks.spec.ts e2e/pwa.spec.ts --workers=2
npm run check:type
```

**Commit:** `test(workspace): cover tabs splits and restoration`

## Phase 2 — Quick Switcher

### Task 7: Note candidate model and deterministic ranking

**Files:**

- Create: `src/lib/workspace/quick-switcher.ts`
- Create: `src/lib/workspace/__tests__/quick-switcher.test.ts`
- Modify: `src/components/vault/AppSidebar.tsx`
- Modify: `src/components/vault/VaultApp.tsx`

- [ ] Add full vault-relative `path` to Markdown sidebar/note records. Keep title derived from filename.
- [ ] Implement a pure ranking function over `{ documentId, title, path }`.
- [ ] Normalize case and Unicode. Match exact title/path first, then title prefix/token, path substring, then fuzzy subsequence.
- [ ] Stable tie order: score, MRU position, lowercase path, document ID.
- [ ] Empty query returns valid recent IDs first, then path-sorted remaining notes.
- [ ] Return match metadata sufficient to highlight title/path portions without putting React inside the ranking module.
- [ ] Test duplicate filenames, Unicode, spaces, punctuation, empty query, stale recents, and deterministic ties.

**Verification:**

```bash
npx vitest run src/lib/workspace/__tests__/quick-switcher.test.ts
```

**Commit:** `feat(search): add quick note ranking`

### Task 8: Quick Switcher dialog and commands

**Files:**

- Create: `src/components/vault/QuickSwitcher.tsx`
- Create: `src/components/vault/__tests__/QuickSwitcher.test.tsx`
- Modify: `src/components/vault/VaultApp.tsx`
- Modify: `src/plugins/core-commands/index.ts` or register the UI-bound command in `VaultPluginBridge`, matching existing theme/dialog precedent

- [ ] Lazy-load the dialog like `CommandMenu`.
- [ ] Hard-wire `Cmd/Ctrl+O`; prevent the browser Open dialog only while Methyl handles it.
- [ ] Register `Quick Switcher: Open` so it also appears in the command palette.
- [ ] Show title, path, graph icon, and recent section. Keep list virtualizable later but avoid a new dependency now.
- [ ] `Enter` calls workspace `replace`; `Mod+Enter` calls `new-tab`.
- [ ] Add `Create “query”` only when `sanitizeName` accepts the filename and no exact title/path exists.
- [ ] Append `.md` when absent. Create at vault root through existing `onCreate`, then open in requested mode.
- [ ] Reset query/selection on close. Restore focus to the previously active editor when possible.
- [ ] Do not change `CommandMenu` full-text behavior or sidebar Search action.

**Verification:**

```bash
npx vitest run src/components/vault/__tests__/QuickSwitcher.test.tsx src/lib/workspace/__tests__/quick-switcher.test.ts
```

**Commit:** `feat(search): add note quick switcher`

### Task 9: Quick Switcher E2E and regression pass

**Files:**

- Create: `e2e/quick-switcher.spec.ts`
- Preserve: `e2e/full-text-search.spec.ts`

- [ ] E2E: `Cmd/Ctrl+O` opens the switcher and ranks title matches over path matches.
- [ ] E2E: duplicate filenames show disambiguating folders.
- [ ] E2E: Enter replaces; Mod+Enter creates a new workspace tab.
- [ ] E2E: create-on-miss creates a valid Markdown note and rejects invalid filenames.
- [ ] E2E: recent order changes after focusing notes and survives reload.
- [ ] Run the existing full-text search E2E unchanged to prove `Cmd/Ctrl+K`/sidebar search still find body text.

**Verification:**

```bash
npx playwright test e2e/quick-switcher.spec.ts e2e/full-text-search.spec.ts --workers=2
```

**Commit:** `test(search): cover quick switcher workflows`

## Phase 3 — Attachments and embeds

### Task 10: Close binary safety gaps and expose metadata

**Files:**

- Modify: `src/lib/core/types.ts`
- Modify: `src/lib/vault/tree.ts` (also remove the known stray NUL byte while touching this file)
- Modify: `src/lib/vault/engine.ts`
- Add/modify tests under `src/lib/vault/__tests__`

- [ ] Extend `VaultTreeNode` with `sha256`, `size`, and `mime` for binary nodes.
- [ ] Change `addBinaryFile` to accept metadata while keeping a narrow compatibility overload only if tests need it.
- [ ] Add binary metadata update methods. Metadata changes are real tree CRDT edits.
- [ ] Make `resolveNameCollisions` continue using stable tree identity; never use mutable hash as identity for conflict ordering.
- [ ] Change `reconcileMaterialization` so it never deletes an untracked non-Markdown file. Until binary reconciliation adopts it, leave it untouched and record diagnostics.
- [ ] Ensure folder move/rename/delete code enumerates both Markdown and binary descendants.
- [ ] Test binary metadata snapshot/import, collision naming, folder mutations, and unknown-file preservation.

**Verification:**

```bash
npx vitest run src/lib/vault/__tests__
```

**Commit:** `fix(vault): preserve and describe binary files`

### Task 11: Streaming asset store adapters

**Files:**

- Create: `src/lib/vault/asset-store.ts`
- Create: `src/lib/vault/__tests__/asset-store.test.ts`
- Modify: `src/lib/vault/opfs.ts`
- Modify: `src/lib/vault/memory-fs.ts`
- Modify: `src/lib/server/fs-store.ts` or add a focused Node adapter beside it

- [ ] Define the `AssetStore` seam described above using lazy `Blob`/stream sources.
- [ ] OPFS writes to a temporary sibling, closes/flushes, then commits to the final path and removes the temporary file.
- [ ] Node writes stream to a temporary sibling, `fsync`s, renames, and cleans interrupted temporary files.
- [ ] Memory adapter copies data for deterministic tests.
- [ ] Hash streams incrementally with existing `sha256Incremental`; do not call `arrayBuffer()` for import/sync hashing.
- [ ] Provide `stat`, `exists`, `listPaths`, `move`, and `remove` with normalized vault-relative paths.
- [ ] Reject `.adhd` materialization targets at this seam as defense in depth.
- [ ] Test multi-chunk writes, large synthetic streams, interruption cleanup, move, and reserved paths.

**Commit:** `feat(vault): add streaming asset storage`

### Task 12: Deep `VaultAssets` lifecycle module

**Files:**

- Create: `src/lib/vault/assets.ts`
- Create: `src/lib/vault/__tests__/assets.test.ts`
- Modify: `src/lib/vault/engine.ts`
- Modify: `src/lib/browser/vault.ts`
- Modify: `src/lib/server/sync-server.ts` engine construction

- [ ] Inject an `AssetStore` into browser and server `VaultEngine` creation/open paths. Existing tests not using assets may use an optional inert adapter during migration, but production must always provide one.
- [ ] Expose one `engine.assets` module. UI/sync must not manipulate binary tree nodes and bytes separately.
- [ ] `importForNote`:
  1. validate the note and filename;
  2. stream-hash the input;
  3. ensure root `Attachments/` exists;
  4. create an in-memory binary tree node with unique name and metadata;
  5. atomically stream bytes to the derived ordinary path;
  6. persist the tree;
  7. durably mark the asset dirty for sync;
  8. roll back the unpersisted tree node when byte write fails.
- [ ] Return `AssetRef { treeId, name, path, sha256, size, mime }`.
- [ ] Add safe note-relative path generation and resolution helpers. Cover `..`, spaces, parentheses, Unicode, percent encoding, and root notes.
- [ ] `writeDownloaded` verifies hash before committing bytes.
- [ ] Asset rename/move/delete and parent-folder mutations update ordinary paths without loading bytes into memory.
- [ ] `open` returns a lazy Blob suitable for object URLs.
- [ ] Add import rollback, collision, relative path, hash mismatch, folder mutation, and reload tests.

**Commit:** `feat(vault): add attachment lifecycle manager`

### Task 13: Sidebar binary rows and asset workspace tabs

**Files:**

- Modify: `src/components/vault/AppSidebar.tsx`
- Modify: `src/components/vault/VaultApp.tsx`
- Create: `src/components/vault/AssetViewer.tsx`
- Create: `src/lib/vault/asset-url-cache.ts`
- Add component/unit tests

- [ ] Add `BinaryRow` to sidebar row types with tree ID, name, path, MIME, size, and hash.
- [ ] Use image/PDF/audio/video/generic file icons. Keep graph notes distinct.
- [ ] Opening a binary resource uses workspace resource `{ kind: "asset", treeId }`.
- [ ] Build `AssetViewer` using a reference-counted object URL cache keyed by `treeId + sha256`.
- [ ] Render image, audio, video, and PDF previews with safe browser primitives. Generic view shows metadata and Download.
- [ ] Revoke URLs on final release, hash change, deletion, and engine replacement.
- [ ] Add asset rename/delete/context actions through `VaultAssets`.
- [ ] Extend workspace pruning and tab labels for assets.
- [ ] Verify mobile preview layout and 44×44 controls.

**Commit:** `feat(attachments): browse and preview vault files`

### Task 14: Paste, drop, file picker, and Markdown insertion

**Files:**

- Create: `src/lib/editor/attachments.ts`
- Create: `src/lib/editor/__tests__/attachments.test.ts`
- Modify: `src/components/editor/NoteEditor.tsx`
- Modify: `src/components/workspace/WorkspaceView.tsx`
- Modify: `src/components/vault/VaultApp.tsx`

- [ ] Build one editor extension configured with `documentId`, `VaultAssets`, and read-only state.
- [ ] Intercept paste only when clipboard contains files. Preserve ordinary text/HTML paste unchanged.
- [ ] Handle file drop at `view.posAtCoords()` and prevent browser navigation.
- [ ] Add `Insert attachment…` in the focused pane toolbar/command, backed by a hidden multi-file input.
- [ ] Import multiple files sequentially or with a low concurrency cap. Preserve user order in inserted Markdown.
- [ ] Insert Markdown only after each corresponding asset import succeeds. Failed files produce a toast and no broken link.
- [ ] Use image syntax only for trusted image MIME/extensions; all others use ordinary links.
- [ ] Respect read-only browser tabs and show the existing writer-lock message.
- [ ] Maintain selection/cursor after insertion and keep undo behavior coherent.
- [ ] Unit-test event classification, Markdown escaping, insertion position, multiple files, partial failure, and read-only behavior.

**Commit:** `feat(attachments): import files from editor`

### Task 15: Inline image embeds

**Files:**

- Modify: `src/lib/editor/live-preview.ts`
- Modify: `src/plugins/core-live-preview/index.ts`
- Modify: `src/lib/plugins/api.ts` only if a narrow asset resolver is needed
- Modify: `src/lib/editor/__tests__/live-preview.test.ts`

- [ ] Extend pure live-preview specs with a local-image spec parsed from standard Markdown image syntax.
- [ ] Never render an embed inside code/frontmatter or while selection touches its source range.
- [ ] Resolve only vault-relative targets through `VaultAssets`; leave `http:`, `https:`, `data:`, and unknown schemes as source text/link behavior.
- [ ] Implement an async image widget using the shared object URL cache. Widget destruction releases its reference.
- [ ] Constrain images to editor width and preserve intrinsic aspect ratio.
- [ ] Render a compact alt/error placeholder when missing, unsupported, or hash verification fails.
- [ ] Ensure async completion cannot mutate a destroyed widget or leak an object URL.
- [ ] Test parser ranges, selection reveal, encoded paths, missing files, URL release, and no underlying Markdown mutation.

**Commit:** `feat(editor): render local image embeds`

### Task 16: Durable asset journal and bidirectional client sync

**Files:**

- Create: `src/lib/sync/assets.ts`
- Create: `src/lib/sync/__tests__/assets.test.ts`
- Modify: `src/lib/sync/coordinator.ts`
- Modify: `src/lib/sync/journal.ts` only where discovery typing is shared
- Modify: `src/lib/browser/sync-host.ts`
- Modify browser sync tests

- [ ] Persist asset dirty entries under `.adhd/sync/assets.json`: `{ treeId, baseHash, newHash, updatedAt }`.
- [ ] `VaultAssets` writes the dirty entry before reporting import/update success. It survives app restart and pre-dates sync configuration.
- [ ] Preserve change type from `/api/changes`; never send asset IDs through document-room sync.
- [ ] Build separate document and asset work sets from local dirty, typed server changes, tree membership, and local missing/hash-mismatch state.
- [ ] Replace current upload-only `syncBinaries` stub with:
  - upload local dirty/new assets;
  - download missing remote assets;
  - verify all hashes before commit;
  - clear dirty entries only after successful durable server response;
  - retain entries on network, validation, or persistence failure.
- [ ] Use bounded binary concurrency of 2.
- [ ] If server bytes do not match merged tree metadata, do not overwrite local bytes; retain work for a later tree-consistent round.
- [ ] Include asset changes in remote-change notifications so sidebar/viewers refresh.
- [ ] Test restart recovery, upload, download, hash mismatch, retry, typed discovery, bounded concurrency, and full-reset discovery.

**Commit:** `feat(sync): synchronize attachments bidirectionally`

### Task 17: Streaming server asset protocol and conflict preservation

**Files:**

- Modify: `src/lib/server/sync-server.ts`
- Modify: `src/lib/server/store.ts`
- Modify/add server integration tests

- [ ] Replace `readBody()` asset buffering with streamed temporary-file writes and incremental SHA-256.
- [ ] Keep an explicit configurable byte limit and return `413` when exceeded, but never buffer up to that limit in memory.
- [ ] PUT requires declared new hash and optional base hash. Reject a body whose computed hash differs.
- [ ] Persist content by digest first, then SQLite asset metadata/change row. A reported success means bytes and metadata are durable.
- [ ] GET streams from disk and returns content length, MIME when known, and hash/ETag metadata.
- [ ] Add metadata/HEAD support so clients decide upload/download without transferring bytes.
- [ ] On base-hash conflict, return `409` with current server metadata; do not overwrite.
- [ ] Client conflict handling preserves both versions:
  1. copy local bytes to a new sibling tree node named `name (conflict <short-device-or-tree-id>).ext`;
  2. mark the new node dirty;
  3. restore/download server bytes for the original stable node;
  4. persist the updated tree;
  5. sync both.
- [ ] Never derive a disk path from the URL ID. Resolve paths only through the merged vault tree.
- [ ] When asset bytes arrive before the tree node, queue materialization and drain it after tree save, matching existing pending document mirrors.
- [ ] Materialize server assets at ordinary vault paths atomically. Renames/moves remove stale old paths.
- [ ] Test auth, traversal-like IDs, hash rejection, stream limit, interrupted upload, conflict, pending-tree ordering, and normal-file materialization.

**Commit:** `feat(server): stream and preserve attachment versions`

### Task 18: External binary ingestion and watcher integration

**Files:**

- Modify: `src/lib/server/vault-watcher.ts`
- Modify: `src/lib/vault/assets.ts`
- Modify: `src/lib/server/sync-server.ts`
- Add watcher/engine tests

- [ ] Watch all ordinary files except `.adhd/**` and temporary files, not only `.md`.
- [ ] Route Markdown changes through existing document ingestion and other files through `VaultAssets.reconcileExternalFiles()`.
- [ ] Reconcile binary paths using path + SHA-256:
  - known path/same hash: no-op;
  - known path/new hash: update metadata and mark dirty;
  - unknown path matching a now-missing tracked hash: move, preserve tree ID;
  - unknown path matching a still-present tracked hash: copy, create tree ID;
  - new hash: create binary node;
  - tracked missing path: deletion, subject to mass-deletion safety rails.
- [ ] Debounce app-originated writes into no-ops through matching tree hash/path state.
- [ ] Publish tree changes and asset change records through existing discovery flow.
- [ ] Never mass-delete binaries after a partial/empty scan.
- [ ] Test external add/edit/move/copy/delete, app-write no-op, mixed Markdown/binary bursts, Git-style replacement, and partial-scan refusal.

**Commit:** `feat(vault): ingest external attachment changes`

### Task 19: Attachment E2E and two-device acceptance

**Files:**

- Create: `e2e/attachments.spec.ts`
- Extend sync integration tests
- Update `README.md`, `TODO.md`, and `SPEC.md` only where implementation now differs from status text

- [ ] E2E: paste an image, verify ordinary relative Markdown, sidebar file, inline embed, asset tab preview, and reload survival.
- [ ] E2E: drop multiple mixed files and verify order plus generic links.
- [ ] E2E: filename collision produces two files and two valid links.
- [ ] E2E: read-only browser tab refuses import without changing Markdown/tree.
- [ ] E2E: mobile file picker path and preview controls work.
- [ ] Integration: device A imports while offline, then syncs; device B downloads, renders, and remains usable after server stops.
- [ ] Integration: server-side external attachment appears on clients.
- [ ] Integration: concurrent binary edits preserve both files and tree nodes.
- [ ] Integration: a synthetic large asset passes upload/download without whole-file buffering instrumentation.
- [ ] Update feature documentation and remove completed attachment TODO entries.

**Verification:**

```bash
npx playwright test e2e/attachments.spec.ts --workers=2
npx vitest run src/lib/vault src/lib/sync src/lib/server src/lib/browser
```

**Commit:** `test(attachments): cover offline and synced file workflows`

## Final verification

- [ ] Run targeted tests after every task before committing.
- [ ] Run complete gates after each phase:

```bash
npm run check:type
npm run check:unit
npm run check:e2e
npm run build
```

- [ ] Run `npm run lint`. The repository currently documents pre-existing lint failures. Fix any touched-file failures and introduce no new warnings; report any untouched baseline failures exactly.
- [ ] Test reduced motion, keyboard-only navigation, 375px portrait, landscape, and desktop split resizing.
- [ ] Inspect browser console during workspace and attachment E2E runs. No React key/hydration errors, unhandled promise rejections, or leaked object URL warnings.
- [ ] Check `git status --short` before each commit. Never include unrelated user changes.
- [ ] Push each passing task or tightly coupled pair. Final branch must be clean and pushed.

## Final acceptance checklist

- [ ] Tabs and split panes ship first and work without Quick Switcher or attachment code.
- [ ] Quick Switcher ships second without regressing full-text search or command palette behavior.
- [ ] Attachments ship third with ordinary-file portability, offline availability, bidirectional sync, and conflict preservation.
- [ ] Focused pane consistently controls editor commands, backlinks, save state, breadcrumb, and URL.
- [ ] Workspace restore cannot resurrect deleted resources or lose unsaved CRDT edits.
- [ ] No unknown ordinary file is deleted during reconciliation.
- [ ] No attachment transfer requires whole-file buffering.
- [ ] No binary conflict discards either version.
- [ ] Server-mounted vault remains directly usable from VS Code, Git, Finder, and normal filesystem tools.

## Handoff prompt

Use this prompt with the implementation agent:

> Implement `docs/superpowers/plans/2026-09-19-workspace-quick-switcher-attachments.md` completely, task by task, in its required order. Use model `gpt-5.6-luna` with maximum reasoning effort. Read `AGENTS.md` and the listed local Next.js guides first. Treat every checkbox and acceptance criterion as required unless code evidence proves a small adaptation is necessary; document adaptations in the plan. Run targeted tests before every commit and full gates after every phase. Commit only your own task files with Conventional Commits, never add co-author trailers, push regularly, preserve unrelated work, and continue until the final acceptance checklist passes or a concrete external blocker requires user input.
