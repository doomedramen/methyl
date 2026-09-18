# Plugins Follow-up Roadmap

> **For agentic workers:** Tracks A and B are executable now (use
> superpowers:subagent-driven-development or superpowers:executing-plans).
> Tracks C–E are outlines: each needs its own short design (brainstorming →
> approved spec) before an implementation plan is written. Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** Close the Phase 1 gaps, find and fix the `removeChild` runtime
error, then deliver plugin Phases 2–4 and the deferred "open note in URL"
item.

**Spec:** `docs/superpowers/specs/2026-09-18-plugin-system-design.md`
(Phase 1 plan: `docs/superpowers/plans/2026-09-18-plugin-system-phase1.md`)

## Global Constraints

- Plugins import only `@/lib/plugins/api` plus the allowlist in
  `eslint.config.mjs`; reach the app only through `app`.
- Every registration is disposable; no plugin data inside `.md` files.
- Commits: conventional, no `Co-authored-by`, never `--no-verify`.
- Every task: `npx vitest run`, `npx tsc --noEmit`, `npm run lint` (error
  count must not rise above the current baseline: 39 errors).
- UI changes are verified in the browser (dev server, `.claude/launch.json`
  "dev"). Browser tool note: send `Enter`, not `Return` (the latter arrives
  with an empty `key`).

## Order

1. **Track B** (removeChild) first — it's a live error the user sees, and its
   root cause may touch the same components as Track A.
2. **Track A** (Phase 1 hardening).
3. **Track F** (open note in URL) — small, independent, can run any time.
4. **Track C** (Phase 3 UI slots + themes) — before Phase 2, because it gives
   visible value (Word Count status bar) and Phase 2's post-processors are
   easier to see with UI slots in place.
5. **Track D** (Phase 2 vault events + markdown rendering).
6. **Track E** (Phase 4 community plugins) — last; needs security design.
7. **Track G** (lint baseline cleanup) — opportunistic, between tracks.

---

## Track B: `removeChild` runtime error

**Symptom:** Next dev overlay: `Runtime TypeError: Cannot read properties of
null (reading 'removeChild')` (Next 16.3.5, Turbopack, React 19). Seen ~20×
in console during the plugin work. The implementing agent claimed it was a
dev-only Fast Refresh artifact, but it only checked one cold load. The user
still sees it, so that claim is unconfirmed.

**Leads:**
- Console also shows `Encountered a script tag while rendering React
  component` — next-themes 0.4.6 renders an inline `<script>` from a client
  component. With React 19 that script can be treated as a React-owned node
  and later removed from a parent that no longer exists.
- Portals: Command dialog, PluginsDialog, Sonner toasts, tooltips. Unmounting
  a portal whose container was already removed produces exactly this error.
- `VaultPluginBridge` swaps `fallbackHost` → real host; the provider value
  change can remount subtrees that contain portals.
- CodeMirror: NoteEditor destroys the view asynchronously
  (`session.dispose(true).then(() => v?.destroy())`) after React has already
  removed the host div — the view's DOM removal can then hit a null parent.

### Task B1: Reproduce deterministically

- [ ] Fresh dev server, fresh tab. Record console with no interaction.
- [ ] Try each trigger separately, reloading between them, and note which
  ones produce the error: open a note; switch notes; open and close ⌘K; run
  a theme command; open and close PluginsDialog; toggle a plugin; trigger a
  toast; switch the theme via the header toggle; switch between a note and a
  graph.
- [ ] Capture the full stack from the overlay (component stack included).
- [ ] Check out `3da2e7d` (pre-plugin) in a temporary worktree on another
  port and repeat the triggers that reproduced. The result says whether
  the bug is pre-existing or regressed.

**Deliverable:** a written repro (trigger, stack, pre-existing yes/no).

### Task B2: Root cause + fix (TDD)

- [ ] Using the stack, pick the matching lead above and confirm it with
  one targeted experiment (e.g. temporarily remove the next-themes script,
  or make NoteEditor destroy the view synchronously in cleanup).
- [ ] Write a failing test where feasible (RTL render → unmount sequence
  under `<StrictMode>`, asserting no thrown error / console.error).
- [ ] Minimal fix, likely one of:
  - NoteEditor: detach the view DOM synchronously in the effect cleanup and
    keep only session flushing async.
  - next-themes: upgrade, or render its script via the documented
    `<head>` pattern for Next 16 (read `node_modules/next/dist/docs` first).
  - Portals: give dialogs a stable container / `keepMounted` as appropriate.
- [ ] Verify in the browser: every trigger from B1 now runs error-free.
- [ ] Commit `fix(...)` describing the root cause.

---

## Track A: Phase 1 hardening

### Task A1: Regression test for editor stability

**Files:** `src/components/editor/__tests__/NoteEditor.stability.test.tsx`
(or the nearest existing NoteEditor test file).

- [ ] Test: render NoteEditor inside a `PluginHostProvider`; capture the
  `.cm-editor` element; re-render with a new `app` value (simulating an
  active-note or save-state change); assert it's the same element and the
  document text is unchanged.
- [ ] Test: VaultPluginBridge exposes one stable `app` across re-renders
  (`useApp()` identity is unchanged after a prop change). Plugins registered
  earlier see the updated `workspace.getActiveNote()`.
- [ ] Temporarily revert `e31e442` locally and confirm both tests fail; then
  restore it.
- [ ] Commit `test(plugins): guard editor/app stability across re-renders`.

### Task A2: Exercise hotkeys and editorCallback end to end

**Files:** `src/plugins/word-count/index.ts`, its test.

- [ ] Convert "Word count: Show" to an `editorCallback` command (it counts
  the active editor's doc), with default hotkey `Mod+Shift+W` (check for
  conflicts with browser shortcuts; fall back to `Mod+Alt+W`).
- [ ] Unit test: the command appears only with an active note and runs
  against the passed `EditorView`.
- [ ] Browser: enable Word Count, focus the editor, press the hotkey → toast
  appears; with no note open, the command is hidden in ⌘K and the hotkey
  does nothing.
- [ ] Browser: add `.adhd/hotkeys.json` override
  `{"word-count:show":[{"modifiers":["Mod","Alt"],"key":"c"}]}` → the new
  combo works and the old one doesn't. Then remove the override.
- [ ] Commit `feat(word-count): editor-scoped command with default hotkey`.

### Task A3: Flaky test hunt

- [ ] Run `for i in $(seq 1 30); do npx vitest run --reporter=dot || break; done`
  and capture the failing test name and output.
- [ ] If found: fix the root cause (likely shared DOM/timers between tests,
  or async enable not awaited). If never reproduced in 30 runs, record that
  in the commit message of A4 and move on.

### Task A4: README

- [ ] Update Features: the theme list (Light, Dark, Obsidian, Obsidian
  Light, Nord, Catppuccin Mocha, Rosé Pine Dawn, System); a "Plugins"
  section (bundled plugins, Plugins: Manage, `.adhd/plugins.json`,
  `.adhd/plugins/<id>/data.json`, `.adhd/hotkeys.json`); a link to the spec.
- [ ] Commit `docs: document themes and the plugin system`.

---

## Track F: Open note in URL (from memory, deferred 2026-09-17)

Small and self-contained; the app uses static export, so use a query param.

- [ ] `?note=<vault path>` updates on select/rename/move/delete (replace
  state, not push, except on explicit open).
- [ ] After the vault loads, resolve path → doc id via the tree; if missing,
  clear the param and show "Nothing open".
- [ ] Tests for path ↔ id resolution; browser check: refresh reopens the
  note.
- [ ] Commit `feat(vault): keep the open note in the URL`.

---

## Track C: Phase 3 — UI slots, themes, graph (needs design)

**Goal:** plugins contribute UI.

Candidate API (to confirm in design):
- `registerStatusBarItem({ id, render, align? })` — footer strip under the
  editor. Word Count shows a live count.
- `registerSidebarView({ id, title, icon, render })` — tab in AppSidebar.
- `addRibbonIcon({ id, icon, title, onClick })` — header or toolbar button.
- `addSettingTab({ id, title, render })` — sections inside PluginsDialog
  (grows into Settings).
- `registerTheme({ id, label, icon, dark, css })` — move `APP_THEMES` and the
  `globals.css` blocks into a `core-themes` plugin. The `dark:` variant can no
  longer be a static selector, so decide how: `data-dark` attribute set from
  the active theme's `dark` flag.
- Graph: `registerGraphNodeType`, `addGraphContextAction`.

**Design questions:**
- How do plugin React components get rendered? They're React, but plugins
  can't import app internals, so pass `render` functions returning React
  nodes from the plugin's own React import.
- How are plugin UI errors contained? One error boundary per slot item.
- Where do theme CSS strings live, and how are they injected (`<style>` per
  theme vs CSS file)?

**Deliverable:** spec `docs/superpowers/specs/<date>-plugins-phase3-design.md`,
then a plan.

## Track D: Phase 2 — vault events + markdown rendering (needs design)

- `app.vault.on("create" | "modify" | "rename" | "delete", cb)` → disposer.
  Source: VaultEngine tree/doc change hooks (local and remote/sync changes —
  the design must say whether remote changes fire events too).
- Grow `app.vault`: real `read`, `list`, `write(id, text)`, `rename`,
  `delete` (currently stubs returning `null` / `[]`).
- Markdown: `registerCodeBlockProcessor(lang, render)` (e.g. mermaid) and
  `registerPostProcessor` as live-preview widgets.
- First consumers: backlinks (sidebar view — depends on C), templates, daily
  notes.

**Design questions:** event ordering and debounce for `modify`; CRDT merge
events vs local edits; performance with large vaults.

## Track E: Phase 4 — community plugins (needs security design)

- Loader: read `.adhd/plugins/<id>/{manifest.json,main.js}`; evaluate as an
  ES module (blob URL + dynamic import) and pass it `Plugin` and `app`.
- Restricted mode on by default; turning it off shows a warning dialog about
  plugins having full access.
- Syncing: `main.js` syncs with the vault. Decide whether a newly synced
  plugin is enabled automatically on other devices (recommended: no, each
  device must confirm).
- Sandbox option (iframe/worker + message-based `App` proxy): decide
  now or later.
- Offline: plugin code cached with the vault (OPFS), so no network needed.

**Design questions:** trust model, updates/versioning, CSP impact
(`blob:` script-src), whether to support Obsidian plugin compatibility (no —
different API).

## Track G: Lint baseline cleanup (optional)

39 errors / 43 warnings pre-existing. Group by rule (`react-hooks/*`,
`no-unused-vars`, etc.), fix per rule in separate commits, and never
suppress without a justification comment.
