# Methyl interaction quality: implementation specification

Status: ready for implementation. This document is a specification, not a claim that the work is implemented.

Audience: Luna implementing a bounded product design pass. Follow the decisions below. Do not replace them with a new design concept.

Baseline inspected: `4498934` (`feat(attachments): browse and preview vault files`), following `6428f73` (initial Things-inspired UI pass). Read the current files before editing; other work may have landed since this inspection.

## 1. Outcome and decision rule

Make it easier to capture, develop, organise, and retrieve thoughts in a Markdown notebook. Borrow Things' care for hierarchy, direct manipulation, restrained feedback, and keyboard access. Do not turn Methyl into a task manager.

Every change must answer at least one question:

- Does it remove a decision or interaction from capturing a thought?
- Does it make the current note, location, action, or persistence state clearer?
- Does it preserve writing continuity while navigating or organising?
- Does it make an existing action equally usable with touch, pointer, and keyboard?

Visual resemblance alone is not justification. Remove unnecessary UI before adding more UI. Completion means the acceptance cases in section 12 pass, not merely that the app resembles a screenshot.

### Explicit scope decisions

| Keep or improve | Remove or simplify | Do not introduce |
| --- | --- | --- |
| All notes, Inbox, Graphs; real folder tree | Collection counts in sidebar and heading | Today, Upcoming, Someday, deadlines, reminders |
| Inbox as an optional capture destination | Motivational collection descriptions and decorative empty-state blocks | Inbox-zero goals, overdue colours, productivity scores |
| Existing Markdown tasks and graph features | Repeated folder names within an already labelled folder group | Task completion celebrations, project progress rings |
| Tabs, splits, attachments, backlinks, templates, search | Always-visible split buttons; redundant title breadcrumb | A Things-style task detail model or draggable Magic Plus |
| Existing themes and system typography | Collection entrance animation replaying on navigation | New fonts, gradients, glass effects, icon packs, animation dependencies |
| Existing delete confirmation and save-error warning | Routine success toasts for rename and move | Undo promises unsupported by the engine, or new trash semantics |

Do not remove Inbox because it resembles Things: OS share and capture paths already depend on it. Do not require users to move notes out of Inbox. Do not automatically delete empty notes.

## 2. Repository map and constraints

Read these files before their corresponding implementation step:

| File | Responsibility and required change |
| --- | --- |
| `src/components/vault/VaultApp.tsx` | Composition, creation, collection selection, save callbacks, header. Separate capture intent from generic creation; derive collection from workspace state; scope save feedback to document identity. |
| `src/components/vault/AppSidebar.tsx` | Navigation and drag-and-drop. Remove collection counts; preserve folder tree, asset rows, drag sensors, keyboard placement, writer guards. |
| `src/components/vault/LibraryView.tsx` | Collection data, groups, empty states. Simplify copy and metadata; add accessible new-tab opening. |
| `src/components/vault/NoteSurface.tsx` | Filename and location above editor. Keep editor identity stable through rename. |
| `src/components/vault/WorkspaceView.tsx` | Tabs and pane controls. Accessible tabs; move split actions into a pane menu. |
| `src/lib/workspace/store.ts` and `__tests__/store.test.ts` | Persisted tabs and panes. Store collection identity on null-resource tabs, backward compatibly. |
| `src/components/vault/CreateMenu.tsx`, `create-actions.ts` | Existing type/template/folder creation. Retain this menu in the sidebar. |
| `src/components/vault/CommandMenu.tsx`, `QuickSwitcher.tsx` | Full-text/command search and title/path switching. Preserve both shortcuts; improve duplicate-title context and focus handling. |
| `src/plugins/core-commands/index.ts` | Register the new capture action alongside existing commands. Do not rename existing command IDs. |
| `src/lib/plugins/api.ts`, `VaultPluginBridge` inside `VaultApp.tsx` | Only extend the command-to-app bridge if capture needs it. Do not route generic plugin `createNote()` calls into Inbox. |
| `src/components/editor/NoteEditor.tsx` | Async CodeMirror creation, attachment insertion, session callbacks. Explicit focus requests and accurate flush acknowledgement; preserve plugin refs. |
| `src/lib/editor/session.ts` | Existing debounced persistence. Inspect before changing save UI; do not assume `flush()` success from a resolved promise because errors are currently caught internally. |
| `src/components/vault/NoteActions.tsx` | Rename and delete dialogs. Await rename result; keep dialog open on failure. Keep destructive confirmation. |
| `src/lib/vault/inbox.ts` | Reuse `ensureInbox`; matches root folder case-insensitively. |
| `src/app/globals.css`, `src/lib/editor/theme.ts` | Shared dimensions, states and reduced-motion rules. Remove obsolete rules after markup changes. |
| `src/components/ui/*` | Existing Base UI wrappers. Use their focus, dismissal, placement and accessibility behaviour. |

Constraints:

1. Read applicable `AGENTS.md` and relevant guides in `node_modules/next/dist/docs/` before implementation. This is Next 16.3.5; do not assume older APIs.
2. Keep CodeMirror/Loro as the document authority. Never keep a second React string as the editor content.
3. Preserve lazy browser-only imports. Do not import the editor/CRDT runtime into server rendering.
4. Preserve attachments, graphs, plugin extension reconfiguration, offline persistence, synchronization, writer-lock takeover, deep links, tabs and splits.
5. Do not modify vault schemas, sync protocols, Markdown file contents, or remote server settings for visual polish.
6. Do not edit or stage unrelated work. At inspection, `src/lib/vault/fs.ts` was already modified. Recheck `git status`.
7. No new dependencies are needed. Use existing Lucide, Base UI, CSS, CodeMirror, and dnd-kit.
8. No global CSS overriding every animation or every button. Scope app-specific rules to app components. A popup rendered through a portal may need an explicit app class.

## 3. Target layout and hierarchy

Desktop, sidebar expanded:

```text
Methyl                    | [Sidebar]                    [save status] [links] [theme] [+]
Search notes       ⌘K     | [note tab] [collection tab] ...                 [+ tab] [···]
                          |
All notes                 | Inbox                    (folder/location label)
Inbox                     | A little breathing room  (rename filename button)
Graphs                    |
                          | A quieter place to think.
Your notes        [+]     |
  welcome                 | Markdown content, using the available pane width
  Inbox                   |
    A little breathing…   |
                          |
Storage status            |
```

The diagram describes hierarchy, not fixed character widths. Retain the current brand header/sidebar creation menu if moving it offers no space benefit. There must be only one creation menu in the sidebar; do not add a second beside “Your notes.”

Header decisions:

- Remove the `All notes > current title` breadcrumb. Sidebar/collection tabs provide navigation; the filename already appears in the tab and document heading.
- Keep the sidebar toggle, save status, backlinks, theme control, and one primary capture button.
- Backlinks remain an explicit button, including when the count is zero. They should not require hover discovery.
- Keep a quiet divider below tabs. Do not hide tabs when only one is open in this pass; that would make the workspace geometry jump.
- Keep the folder path above the filename. It communicates location; it is not a second filename. Use `Notes` for root notes.

Dimensions:

| Element | Target |
| --- | --- |
| Sidebar | Existing 256px desktop width; mobile drawer remains |
| Main header | 56px desktop, 56–60px mobile; controls must fit at 320px |
| Tab strip | 40px desktop; at least 44px on touch layouts |
| Document canvas | Maximum 1100px **including gutters**, centred in its pane |
| Document gutters | 24px for pane width <= 600px; 48px above 600px |
| Collection canvas | Maximum 900px including the same gutters |
| Filename / collection title | 28px, weight 650–700, line-height 1.25; 24px in panes <= 460px |
| Editor body | Existing 16px / 1.7; preserve Markdown typography |
| Navigation | 14px; secondary metadata 12px |
| Collection row | Minimum 48px desktop, 52px touch; grow if metadata wraps |
| Focus outline | 2px visible ring with 2px offset; no layout movement |
| Pointer-only icon hit area | At least 32px |
| Touch hit area | At least 44px in both dimensions, including tab close and overflow |

Use pane/container width for gutters, not viewport width. A narrow split in a wide window must use narrow gutters. Define `--note-page-gutter` on the pane content container or its descendants, and consume it in both `.note-heading` and `.cm-content`. Retain the existing 1100px shared cap. At viewport 1280px with a 256px sidebar, both title and body text begin at x=304px. Their left edges must differ by <= 1 CSS pixel.

Do not hard-code the Catppuccin screenshot colours. Use existing semantic theme tokens. Keep current collection icon colours, adjusted only when contrast requires it. Colour must not be the only selection signal. Test light, dark and Catppuccin; smoke-test the other offered themes.

## 4. Collections: navigation without administrative pressure

### Content

Keep All notes, Inbox and Graphs. Remove numeric badges from collection navigation and headings. Remove the current `COLLECTIONS.description` marketing copy, the empty-state icon tile, and the “Looking for something? Search your notes” footer. Search already has a permanent home.

Use exactly these empty states:

| Collection | Heading | Supporting text | Action |
| --- | --- | --- | --- |
| All notes | No notes yet | Write a thought to get started. | New note |
| Inbox | Your Inbox is empty | Capture a thought here whenever you need to. | New note |
| Graphs | No graphs yet | Connect ideas on a canvas. | New graph |

Render the action once, not inside and below the empty state. For populated collections, put the same quiet action below the list. Do not announce the empty Inbox as an achievement or show a completion checkmark.

All notes continues to include all Markdown notes, including graph documents. Graphs filters by `isGraph`. Inbox remains the direct Markdown children of the root Inbox folder, case-insensitively; nested folders remain available in the tree. Assets stay in the tree and asset viewer; do not add them to note search or collections in this pass.

Recently opened uses the first three valid, distinct IDs from workspace history. Skip deleted entries. Remove those entries from folder groups to avoid duplicated rows. Preserve current tree ordering for the remaining groups. In Recently opened, show each item's folder path, or `Notes` for root. In a folder group, omit the redundant path on every row. Same-named notes must still be distinguishable by group/location. Remove the decorative trailing chevron from note rows.

### Persist collection identity

Current defect: `VaultApp.collections` is component state keyed by tab ID. An Inbox tab becomes All notes after reload.

Implement with an optional field on `WorkspaceTab`, not a new resource kind:

```ts
export type WorkspaceCollection = "notes" | "inbox" | "graphs";
interface WorkspaceTab {
  id: string;
  resource: WorkspaceResource | null;
  collection?: WorkspaceCollection; // relevant only when resource === null
}
```

Move/reuse the collection type without importing React components into the store. `LibraryCollection` can alias the store type.

- Keep snapshot version 1: this is an additive optional field. Old null-resource tabs default to `notes`.
- Parse only the three recognised strings; invalid values default to `notes`. Preserve document/asset resources and their IDs.
- Clone the field everywhere snapshots/tabs are cloned. Clear it when a tab receives a resource.
- Add `store.openCollection(collection, paneId?)`: find a null-resource tab in the target pane, set its collection and activate it; otherwise append one. Never replace a document/asset tab to open a collection. Never steal a collection from another pane.
- `newTab()` creates an All notes tab. Closing the last tab resets it to All notes. Closing one of several tabs retains existing neighbour-selection behaviour.
- Remove `VaultApp.collections`; derive labels, active sidebar state, and rendered collection from the persisted tab.
- Collection tabs do not enter `recentDocumentIds`. URL behaviour stays unchanged: collections use `/`; note paths remain deep links. A valid explicit note URL wins over restored collection selection.
- Opening a collection row normally uses existing replace semantics. Cmd/Ctrl-click and the existing quick switcher's Cmd/Ctrl+Enter use new-tab mode. Preserve the store's existing deduplication of an already-open document.

## 5. Capture: one click to a writing surface

The top-right primary `+` becomes a button, not a menu. Accessible name and tooltip: `Capture a thought`. Clicking it creates an untitled Markdown note in Inbox and focuses the editor once the editor is ready. Reuse the active collection tab when it has no resource; otherwise open a new tab in the focused pane. It must preserve the previously open document tab.

Keep the sidebar `CreateMenu` for New note, From template, New folder and New graph. This is the place for deliberate creation choices. Do not remove these capabilities to achieve visual simplicity.

Routing contract:

| Entry point | Destination | Open mode |
| --- | --- | --- |
| Header Capture a thought / new command with same label | Inbox | Reuse active null-resource collection tab; otherwise new tab |
| New note in All notes | Root | Replace active collection tab |
| New note in Inbox | Inbox | Replace active collection tab |
| New graph in Graphs | Root | Replace active collection tab |
| Sidebar creation menu | Existing request's explicit parent; root when absent | Existing behaviour |
| Folder-specific creation | Explicit folder | Existing behaviour |
| Plugin `createNote`, quick-switcher Create from query | Preserve existing explicit parent/root semantics | Existing behaviour |
| OS share / file handlers / `?action=` | Preserve existing routing | Preserve existing behaviour |

Use `ensureInbox(engine)` for capture. Do not globally change `createNote(undefined)` to mean Inbox. Give capture its own function and registered command. No new global shortcut in this pass: browser reservations and user/plugin shortcuts require a separate decision. Existing Cmd/Ctrl+K can discover the capture command.

Implementation details:

- Check writer ownership before creating Inbox or any document. Disable all creation controls while unavailable/read-only; command invocation uses the existing takeover message.
- A capture activation creates exactly one document. Use an in-flight guard until the first capture has opened and its initial persistence attempt settles. A rapid double click must not create two notes.
- Do not ask for a name first. Keep the title `Untitled` and body placeholder `Start writing…`.
- Return/store the new document ID and intended tab ID. Send an explicit focus request to that editor; do not query and focus the first `.cm-content` in the document.
- If async editor setup finishes after the user changes tabs or opens a dialog, do not steal focus. A pending focus request is consumed only while its tab is active and no modal owns focus; cancel it when the user navigates away.
- Creating a note persists the tree and document through existing engine methods. Catch initial persistence failures. Keep the in-memory note visible and show the existing actionable save-error warning. Do not claim creation was saved and do not silently remove the note.
- Do not add sample content or auto-delete empty captures.

## 6. Writing continuity and title editing

Keep filename renaming in the existing dialog. Do not implement a new inline title editor in this pass.

- The title button supports click, Enter and Space. Show the pencil on hover, focus, and touch layouts. Long titles may wrap to two lines; do not push controls offscreen.
- Show the current filename when opening the dialog, without rewriting Markdown headings/content.
- Change the rename callback contract to await success or propagate a failure. On submit, keep the dialog open and disable repeated submission until the operation finishes.
- On failure, retain the entered text, show `Couldn't rename note. Try again.` in an alert in the dialog, and re-enable submission. Do not close and lose the attempted name.
- On success, close the dialog, update title/tab/tree, and return focus to the initiating title or row action. On cancel/Escape, preserve filename and restore focus.
- Remove the routine `Note renamed` toast. The updated name is the confirmation. Keep actionable error messages, avoiding duplicate toast plus inline error for the same failure.
- Do not key `NoteEditor` by title, path, save status or collection. Preserve the current stable tab identity and document lifecycle. Renaming must preserve selection, scroll position and editor undo history.
- Opening search or a menu and cancelling returns to the previous editor selection. Selecting another note from search focuses that selected note's editor after readiness, without changing its text.
- Do not add animations to text, the caret, Markdown headings, or editor mounting.

## 7. Secondary controls and keyboard parity

### Pane controls

Keep New tab visible. Replace the always-visible split-right, split-down and close-pane buttons with one `Pane options` menu next to New tab. Use the existing menu primitives.

Menu items: `Split right`, `Split down`, and `Close pane` (only when more than one pane exists). Preserve the existing store methods and resource behaviour. Do not disable desktop splits simply because the viewport is narrow; retain existing responsive behaviour.

Tab close buttons appear on desktop hover **and focus-within**. They remain visible on touch/coarse-pointer layouts. Hidden controls must not leave an invisible focus stop: focusing their containing tab/row reveals them before their own focus is reached.

Implement tablist keyboard behaviour: one tab in each tablist has `tabIndex=0`; others `-1`. Track the roving focus target separately from the active document; when focus enters from outside, start at the active tab. Left/Right focus adjacent tabs without wrapping; Home/End focus first/last. Use manual activation: Enter/Space activate the focused tab; arrows do not unexpectedly replace the document being edited. Scope these keys to the tab buttons. Never intercept arrows inside CodeMirror or sidebar drag-and-drop. Closing a focused tab moves focus to the active neighbour; closing the last one focuses its All notes tab. Give tab buttons IDs and associate the active panel with `aria-controls`/`aria-labelledby`.

### Search

Keep Cmd/Ctrl+K full-text search plus commands and Cmd/Ctrl+O title/path quick switcher. Do not merge their ranking models or remove either shortcut. Use platform-correct shortcut labels (reuse `formatHotkey`; do not hard-code ⌘ on Windows/Linux).

Add a secondary path label to CommandMenu results so duplicate titles are distinguishable. Empty results remain factual: `No matching notes or commands.` Do not auto-create from full-text queries. Retain the quick switcher's explicit Create action and new-tab shortcut.

Escape dismisses only the topmost popup. Menus and dialogs must restore focus through Base UI; do not add competing document-wide Escape handlers. Header icon-only controls need accessible names and tooltips. Creation, search and navigation must not depend on hover.

## 8. Save feedback must be truthful and local to the document

Current code sets `saved` immediately on Cmd/Ctrl+S, before persistence finishes. Save callbacks also share a global state across editors in splits. Fix both as part of interaction trust, without rewriting synchronization.

Use document IDs to route callbacks and a map of document save states. A callback from note A must never display `Saved` or an error against focused note B. A background note failure still requires an actionable error notification identifying the note. Do not mislabel local persistence as remote sync completion.

State contract:

| State | Visible feedback | Exit |
| --- | --- | --- |
| Unchanged/opened | No badge | First edit or explicit save |
| Edited/pending | `Unsaved changes` in muted text | Actual persist starts/completes/fails |
| Persisting | `Saving…`; spinner only if still pending after 250ms | Persistence result |
| Persist succeeded and no newer edits remain | `Saved` for 1500ms, then hidden | New edit immediately overrides |
| Persist failed | `Not saved` stays visible; actionable existing error warning | Successful retry of that document |

Cmd/Ctrl+S targets only the focused writable editor/graph. Do not broadcast the same counter to every mounted split editor. If the current session is clean and not persisting, `Saved` may be acknowledged immediately; otherwise wait for a real result. An older successful write must not clear a newer dirty/error state.

Inspect `EditorSession.flush()` and existing graph persistence before wiring UI. It currently returns `Promise<void>` and catches errors; awaiting it alone is not a success signal. Prefer explicit persistence start/success/error callbacks and session status or a typed flush result. Include an edit generation/request identity if necessary. Keep changes limited to establishing a truthful acknowledgement contract. Keep debounce timings and storage/CRDT behaviour unchanged unless a targeted correctness test proves a change necessary.

Reserve enough status space that header icons never move when the label changes. On small screens, a status icon may replace visible text; expose the full state in an accessible label and tooltip. Use a polite live region for explicit save completion and an alert for failure. Do not announce every keystroke or every background autosave.

## 9. Motion specification

Motion explains a state change. No ambient animation. Do not animate routine note/collection navigation with a whole-page entrance.

Define shared scoped tokens: fast 100ms; standard 160ms; exit 120ms; ease-out `cubic-bezier(.2,.8,.2,1)`.

| Interaction | Motion | Reduced motion |
| --- | --- | --- |
| Button press | Colour immediate; primary capture icon/button scales to .97 while pressed, returns in 100ms | Colour only |
| Menu/popover open | Opacity 0 to 1 and scale .98 to 1, 160ms from trigger origin | Instant visibility |
| Menu/popover close | Opacity 1 to 0, 120ms; no delayed pointer interception | Instant dismissal |
| Folder disclosure | Chevron rotates 90 degrees, 120ms; children appear without stagger | Immediate rotation/state |
| Note move confirmation | Preserve existing pointer/keyboard DnD; tint destination row with selection token for 600ms after successful commit | Same static tint, no movement |
| Save label | Opacity transition <=100ms within reserved space | Immediate text/icon update |
| Collection/tab selection | Immediate active colour, optional 100ms colour transition | Immediate |
| Sidebar/sheet | Retain current gesture-following behaviour and established transitions | No automatic translation transition; drag follows finger |

Remove `paper-appear` and checkbox press scaling from the first pass. Keep Markdown checkbox's functional checked-state change; do not add task-manager completion rituals.

Do not add FLIP layout animation or spring libraries. Do not change dnd-kit collision, depth, auto-scroll, keyboard placement, or its live announcements. Apply move-confirmation tint only after the existing successful commit path; never before a failed move. Clear timers on unmount and when another move starts. Rapid open/close must reverse/dismiss cleanly without leaving invisible overlays.

## 10. Empty, loading, error and read-only states

- Existing vault loading skeleton remains; do not render a misleading empty library before load completes.
- Preserve the writer-lock banner and takeover action. Renaming, capture, deletion and moving must honour the writer guard. Reading, search and navigation remain available.
- A missing document is not an empty notebook. Replace inappropriate `VaultEmpty` use for a missing resource with `This note is unavailable` and an `All notes` action. Do not create a replacement note automatically. Keep asset-specific errors in AssetViewer.
- Rename failure retains the dialog input. Capture/save failure retains the text. Search with no matches retains the query.
- Delete stays behind the existing confirmation. Do not add an Undo button unless backed by an existing proven recovery API; implementing new recovery storage is outside scope.
- Existing graph and attachment error handling remains functional. Do not replace specific errors with generic calming prose.

## 11. Ordered implementation packets

Complete each packet before starting the next. Small commits should describe behaviour, not “polish.” No separate agents are required.

1. **Persist navigation state.** Add optional collection field, parser/cloner handling, `openCollection`, and store tests. Wire VaultApp/LibraryView to the store. Verify old snapshots and reload before changing styling.
2. **Simplify chrome and collections.** Remove counts/copy/breadcrumb; apply dimensions; pane options menu; metadata rules; factual empty states. Keep every existing creation capability accessible.
3. **Direct capture and focus.** Add dedicated capture handler and command, use the header button, enforce routing/guards, consume focus requests after editor readiness. Update tests that intentionally expected the old header Add menu.
4. **Editing and search continuity.** Await rename, retain errors/input, restore focus, add result paths, implement tablist keyboard semantics. Do not alter editor content or remount it for presentation changes.
5. **Truthful save feedback.** Scope requests/events to document identity, remove optimistic confirmation, handle clean saves and failures. Test with deferred/rejected writes before adding transitions.
6. **Restrained motion and touch states.** Apply section 9, remove old entrance/checkbox effects, verify reduced-motion and gesture behaviour.
7. **Whole-flow validation.** Run section 12; inspect actual rendered screens, fix failures, and record evidence. Do not declare “Things quality”; state what is demonstrably improved and any remaining limitation.

If a discovered constraint conflicts with this specification, document the exact conflict and a concrete proposed adjustment. Do not quietly omit the requirement or build unrelated infrastructure.

## 12. Acceptance tests and completion gate

### Automated behaviour tests

Extend existing tests rather than deleting assertions to make them pass. Add focused tests for stateful changes; do not snapshot every CSS value.

| ID | Scenario and required result | Suggested location |
| --- | --- | --- |
| NAV-1 | Old version-1 snapshot loads; missing/invalid collection defaults to All notes; document and asset tabs survive | `src/lib/workspace/__tests__/store.test.ts` |
| NAV-2 | Inbox and Graphs tabs survive reload in separate panes; opening collection preserves document tabs; last-tab close resets All notes | Store tests + `e2e/library.spec.ts` |
| NAV-3 | Collection row ordinary activation replaces collection tab; Cmd/Ctrl-click opens new; already-open note uses existing deduplication | `e2e/library.spec.ts` |
| CAP-1 | Header capture opens exactly one blank note in Inbox, preserves previous note tab, focuses correct editor; rapid double activation creates one note | New `e2e/capture.spec.ts` |
| CAP-2 | Lowercase root `inbox` is reused; no duplicate Inbox; no filename prompt; text survives reload | Capture tests; reuse Inbox unit tests |
| CAP-3 | All notes New note creates at root; Inbox New note creates in Inbox; sidebar graph/template/folder actions remain reachable | `e2e/create-menu.spec.ts`, `templates.spec.ts`, library tests |
| CAP-4 | Read-only capture cannot create a folder/document; command reports takeover guidance | Targeted handler test or browser writer-lock fixture |
| FOCUS-1 | Capture setup completing after navigation does not steal focus; cancelling search restores editor selection | Capture/focus browser tests |
| EDIT-1 | Rename changes filename only; text, selection and undo survive; cancel changes nothing | `e2e/library.spec.ts` |
| EDIT-2 | Rejected rename keeps attempted title in an open dialog; retry succeeds and restores focus | Component test with rejected/deferred callback |
| SAVE-1 | Deferred write never shows Saved early; rejection shows Not saved; successful retry clears failure | Session/component tests with controlled promises |
| SAVE-2 | Split A callbacks cannot change B's badge; Cmd/Ctrl+S flushes only focused editor; clean explicit save acknowledges | Focused component + browser coverage |
| SAVE-3 | Edit arriving while a write is pending remains dirty until that edit is persisted | Existing/new session tests; do not fake success with timeouts |
| KEY-1 | Tab arrows/Home/End move focus only; Enter/Space activates; close restores focus; no CodeMirror/DnD arrow regression | New `e2e/workspace-accessibility.spec.ts` + existing DnD tests |
| FIND-1 | Full-text results distinguish duplicate titles by path; Cmd/Ctrl+K and Cmd/Ctrl+O retain their behaviours | `e2e/full-text-search.spec.ts` + quick-switcher tests |
| ERR-1 | Deleted/missing document shows unavailable state and working All notes action, not an empty-note creation prompt | Library/workspace test |
| MOTION-1 | Reduced-motion disables new transforms/transitions; menus remain usable and overlays disappear after rapid dismissal | Mobile/motion browser test |
| WIDTH-1 | Title/body left edges align within 1px; no horizontal page overflow at 320, 375, 768, 1280; split panes use their own gutters | `e2e/mobile-quality.spec.ts` |

Use test-only mocks/fixtures for failures and pending writes. Do not expose test controls on the production UI. For time-based tests use controlled clocks where available; avoid arbitrary sleeps. No visual-only change needs a mirrored unit test.

### Manual visual and interaction review

Inspect screenshots and interact with the app at desktop 1280×850, small phone 375×667, 320px width, and a narrow split pane. Capture evidence in a short implementation report (paths or attached screenshots), without committing private user notes. Use disposable test-vault data for destructive tests.

Required fixture: a root note, three recent notes, a nested folder, two notes with the same title in different folders, a very long title, a graph, an attachment, and a long Markdown note. Include empty Inbox and populated Inbox.

Verify:

- Light, dark and Catppuccin retain legible secondary text, focus rings, selection, and errors. Check all other theme options for broken colour inheritance.
- Editor width meets the user's explicit request. Long text wraps; long filenames do not cover controls. Title and body align in both split and single-pane layouts.
- The page does not stack motivational copy, count badges, repeated metadata or decorative panels around a simple list of notes.
- Touch controls meet 44px targets. Tab close/pane options require no hover. Mobile keyboard does not hide the search input or active editor caret.
- Search, menu, rename and capture flows have predictable focus. Keyboard tab order follows the visible layout. Escape closes the topmost popup only.
- Typing, renaming and autosaving do not animate/remount the editor or lose undo/selection. Save feedback does not move header buttons.
- Existing pointer and keyboard note movement still work, including nested folders and invalid drops. Move tint confirms the actual destination.
- Tab switching, links, attachments, graph editing, templates, mobile drawer gestures, offline use and writer takeover still work.
- Inspect menu opening/closing as a sequence, not only a screenshot. Try rapid reversal and reduced motion. No popup remains invisible but intercepts clicks.

### Commands and reporting

Run focused tests during each packet. Then run `npm run check:type`, `npm run check:unit`, and `npm run check:e2e` once the combined change is ready. Use the configured production E2E server (default port 3100); do not point its 127.0.0.1 configuration at the localhost development server, which previously produced cross-origin failures.

Respect repository hooks. Pre-commit runs type/unit checks. Pre-push runs full CI checks and the Docker build. Never bypass hooks. Commit only this work, without co-author trailers, and push as requested by the repository instructions. Avoid simultaneous Git mutations with other work in the shared checkout.

Final report must list completed packets, test results, visual-review evidence, commit IDs, and any unmet acceptance case. Do not hide a failure behind “polish complete.”

## 13. Reference and handoff

The earlier [Things research](../design/things-inspired-ui.md) records observed screenshots and interactions. It is background; this specification supersedes its initial implementation choices where they conflict (counts, copy, list width and entrance motion).

Primary references already reviewed:

- [Things features](https://culturedcode.com/things/features/): compact hierarchy, progressive disclosure, direct capture and spatial feedback.
- [Quick Find](https://culturedcode.com/things/support/articles/2803584/): fast retrieval with keyboard support.
- [Quick Entry](https://culturedcode.com/things/support/articles/2249437/): low-friction capture.
- [Mac design screenshot](https://culturedcode.com/frozen/2025/09/things-os26-screenshot-macos-io75.jpg) and [phone screenshot](https://culturedcode.com/frozen/2025/09/things-os26-screenshot-ios-io75.jpg): hierarchy and spacing references, not layouts to copy literally.

Suggested implementation prompt:

> Implement `docs/specs/2026-09-19-notebook-interaction-quality.md` in order. Read its repository map and constraints first. Treat its routing, state contracts, copy, dimensions and motion table as decisions, not suggestions. Preserve unrelated changes. Complete all seven packets and their acceptance checks. Test actual keyboard, pointer, touch and reduced-motion flows. Commit and push without bypassing hooks. Report anything unmet; do not substitute visual resemblance to Things for the specified notebook behaviours.
