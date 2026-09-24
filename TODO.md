# TODO

Work that [SPEC.md](SPEC.md) doesn't already describe: bugs found in use, gaps
between the spec and what's built, and polish. Features the spec covers
(attachments, graph view, Mermaid/math, export, multi-vault, mobile/iOS
limits) live there, not here — only their *deviations* are listed below.

## Bugs

- [ ] **Vault wipe, cause unconfirmed.** A browser vault once lost its tree and
      every CRDT file under `.adhd/crdt`. Never reproduced. Safety rails (empty-scan
      guard, index rebuild, mass-deletion refusal, reserved-path guard) and a
      diagnostics ring buffer are in place; if it recurs, read the buffer via
      "Copy diagnostics" in the status popover.
- [x] **`src/lib/vault/tree.ts` reads as binary** — no longer: `file` reports
      UTF-8 text and there are no control bytes left in it.
- [x] **Lint** is clean and runs in CI and pre-commit with `--max-warnings=0`.
- [ ] **Cmd/Ctrl-click on a wikilink is unverified with a real mouse.** It works
      when the event is dispatched directly; the automation tool's modifier-click
      never reached the page.

## Gaps against what's built

- [x] **Full-text search wired up.** ⌘K searches note titles and Markdown
      content through the MiniSearch index.
- [x] **Backlinks.** A "what links here" panel lists notes that link to the
      active note and opens them on selection.
- [ ] **Sync isn't live.** Remote changes arrive on the next discovery round
      (~15s), not pushed: `loro-websocket`'s `SimpleServer` has no public API to
      broadcast into an already-joined room. Fixing it means patching the
      vendored package.
- [ ] **Sync token is stored in `localStorage`.** Fine for a LAN deployment,
      readable by anything with access to the browser profile. SPEC §31 describes
      a pairing flow that isn't implemented.
- [ ] **No release tag**, so no version is shown anywhere and the diagnostics
      summary reports `NEXT_PUBLIC_APP_VERSION` only if it's set at build time.
      `latest` currently tracks `main`.
- [ ] **Upstream bug not reported:** `loro-codemirror`'s `LoroSyncPluginValue`
      swallows the first view update when the initial content already matches
      (worked around in `NoteEditor.tsx`). Repro: `loro-codemirror-swallow.test.ts`.

## Editor polish

- [ ] Slash (`/`) menu: headings, lists, tables, code blocks, date.
- [ ] Smart paste: URL over a selection becomes a link; pasted HTML becomes Markdown.
- [ ] Image/file paste and drop into a note (needs attachments — SPEC).
- [ ] Table helpers: Tab between cells, keep columns aligned.
- [ ] Drag to reorder blocks from a gutter handle.
- [ ] Wikilink affordance: no hint that Cmd/Ctrl is needed — tooltip, or a pointer
      cursor while the modifier is held.
- [ ] Selection colour uses `--accent`, which reads heavy now that the
      current-line highlight is gone.

## UI polish

- [ ] **Real logo.** The current mark is a placeholder (bars standing in for lines
      of text), square by design so iOS can apply its own mask.
- [ ] **Manifest icon `purpose`** is `any`; add a `maskable` entry so Android
      launchers crop to their own shape.
- [ ] **Onboarding.** Nothing explains ⌘K, sync setup or wikilinks beyond the
      welcome note.
- [ ] **Folder vs note icon alignment:** notes sit at the gutter, folders indent by
      the chevron column. Deliberate, but worth a second look.

## Quality

- [ ] **Real-device mobile QA remains.** Chromium iPhone emulation now covers
      375px portrait, landscape, touch targets, editor overflow, sheet dismissal,
      reduced motion, and the iOS-style edge cases; a physical iOS/Android pass
      is still needed for keyboards, safe-area insets, press-and-hold dragging,
      and browser storage limits.
- [ ] **No accessibility pass:** keyboard-only navigation, screen readers, focus
      order, and a keyboard path for moving notes between folders.
- [ ] **Offline verified only in Chrome**, by stopping the server; not on iOS
      Safari, which has the storage limits SPEC §15 describes.
- [ ] **Image is 464MB.** Most of it is the Debian base, Node and
      `better-sqlite3`; distroless or Alpine would cut it if it matters.
- [ ] **Flaky tests:** two timing-dependent sync tests have been stabilised; watch
      for others under full-suite load rather than in isolation.
- [x] **Sidebar drag-and-drop now has real-browser e2e coverage**
      (`e2e/sidebar-organise.spec.ts`, `npm run test:e2e`) — create/nest/reorder/
      move-out/refuse-descendant, asserting both the sidebar tree and the OPFS
      files on disk. Added after three drag bugs (drop-into-folder computed only
      in `onDragOver`, and a Loro remove-then-reinsert index overshoot on
      downward moves) shipped uncaught, since jsdom unit tests have no real
      layout for dnd-kit's hit-testing to run against.
