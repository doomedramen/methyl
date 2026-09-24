# Methyl hardening, sync and multi-vault: implementation specification

Status: ready for implementation. This document is a specification, not a claim that the work is implemented.

Baseline inspected: `ae75f3d` (`test(a11y): select templates as buttons`). Read the current files before editing; other work may have landed since this inspection.

Scope: the 19 improvements identified in the 2026-09-24 project review, plus item 20 (PWA startup time), added after the review. Each item has a problem statement, the required change, and acceptance criteria. Section 8 orders the work; follow that order unless an item is explicitly independent.

Where this document and [SPEC.md](../../SPEC.md) disagree, this document wins for the items it covers. When an item lands, update `TODO.md` (tick or remove the entry) and SPEC.md (where the architecture changed) in the same change.

## 0. Decisions already made

| Question | Decision |
| --- | --- |
| How one server hosts several vaults | **One process, many folders.** One container, one port. Each subfolder of a mounted vaults directory is a vault with its own SQLite database, watcher and room namespace. |
| How to make sync live | **Own WebSocket room server on `loro-protocol`.** Replace `loro-websocket`'s `SimpleServer`; remove the internal loopback port, the raw TCP upgrade proxy and the private-field patching. |
| Metadata directory name | `.adhd/` becomes `.methyl/`, migrated automatically. Done together with multi-vault, because both change on-disk layout. |
| Long-lived credentials in JavaScript | Not allowed. Implement the pairing flow SPEC §31 describes. |

## 1. Constraints that apply to every item

1. Read `AGENTS.md` and the relevant guide in `node_modules/next/dist/docs/` before touching Next.js code. This is Next 16.3.5.
2. Markdown files stay clean: no IDs, markers or app metadata inside `.md` files (SPEC §3, invariants in §47).
3. Every on-disk or in-OPFS format change ships with a forward migration that is **idempotent, crash-safe and tested**. It must be safe to run twice, and safe to kill halfway and rerun. Never delete the old copy until the new copy has been read back and verified.
4. No test may be skipped, disabled or quarantined to make a change pass.
5. Pre-commit (`lefthook.yml`) runs unit tests and typecheck, and pre-push runs `check:ci` and the Docker build. Do not bypass them.
6. Each numbered item below is one PR (or a short series) with its own tests. Do not bundle unrelated items.

---

## 2. Data safety

### 2.1 Find the cause of the vault wipe (item 1)

**Problem.** One browser vault lost its tree and every file under `.adhd/crdt`. The cause is unknown. Safety rails exist in `src/lib/vault/engine.ts`: an empty-index guard (~line 689), an empty-scan refusal (~803), a mass-deletion refusal (~858) and reserved-path write/remove refusals (~165). A diagnostics ring buffer (`src/lib/vault/diagnostics.ts`) records events. None of this explains the wipe, and all of it treats symptoms.

**Required change.**

1. **Deletion audit.** Route every destructive filesystem call (file remove, directory remove, recursive remove, tree-node delete that cascades to CRDT files) through one function in the vault store layer (`src/lib/vault/store.ts` / `opfs-store.ts` / `fs.ts`). It records `{op, path, caller, treeSizeBefore, docCountBefore}` to the diagnostics buffer before acting. Add a lint-level or unit-test check (extend `src/lib/core/__tests__/architecture.test.ts`) that no other module calls the raw remove APIs.
2. **Recursive-remove guard.** Refuse any recursive remove of the vault root, of `.adhd/` (later `.methyl/`) or of `.adhd/crdt` itself, whatever the caller. Log a `refuse-root-remove` diagnostic.
3. **Model-based fuzz test.** Add `src/lib/vault/__tests__/engine-fuzz.test.ts` using the in-memory FS (`src/lib/vault/memory-fs.ts`). Generate random interleavings of: create/rename/move/delete note and folder, external disk edits via `ingestExternalChanges`, sync imports of remote tree/doc snapshots, engine restart (reload from store), concurrent second engine on the same store (simulating a lost Web Lock), and simulated crashes between write steps. After each step assert invariants:
   - the tree is never empty while the model says notes exist;
   - every tree node that is a note has a CRDT file, and every CRDT file is referenced or is a pending orphan;
   - no Markdown file disappears unless the model deleted it.
   Use a seeded PRNG; print the seed on failure so it can be replayed. Run 200 sequences in CI and allow `FUZZ_RUNS` to raise it locally.
4. **Lock-loss path.** Explicitly test the case the fuzzer simulates in point 3: two engines writing the same store. If it can wipe data, make a read-only tab's engine incapable of writing (throw at the store layer, not just the UI).
5. **Close the loop.** If the fuzzer finds a wipe, fix it and keep the minimal sequence as a named regression test. If it finds none after the work above, record that in `TODO.md` with the audit trail as the remaining detection mechanism.

**Acceptance.** Fuzz test in CI; every destructive call goes through the audited function; root/metadata recursive removes are refused with a diagnostic; the lock-loss test passes.

### 2.2 Backup, export and restore (item 2)

**Problem.** SPEC §40 specifies export, but it isn't built (`fflate` is a dependency and is unused). A self-hoster has no documented way to back up or restore the server.

**Required change.**

1. **Browser export** (SPEC §40): add *Export vault* to the command menu and the vault settings. Use `fflate`'s streaming ZIP. Two modes:
   - *Portable*: the Markdown files and attachments only, with the vault's folder structure.
   - *Full backup*: the above plus the metadata directory (`.methyl/`, CRDT state, index).
   Stream to a download; don't build the whole ZIP in memory.
2. **Browser import of a full backup**: restores into a **new** vault (depends on item 9, multi-vault). Never overwrite the current vault. Portable ZIPs reuse the Obsidian importer path (`src/lib/vault/obsidian-import.ts`), which already handles a folder of Markdown plus attachments.
3. **Server backup command**: `node dist/server.cjs backup <vault> <out.tar>` (and a `methyl-backup` entry in the Docker image). It uses SQLite's online backup API (`better-sqlite3` `db.backup()`) for the database and copies the vault folder, so it is safe while the server runs. Add `restore` that refuses to run while the server holds the vault.
4. **Docs**: a README section with the backup command, a cron example, and restore steps.

**Acceptance.** Round-trip tests: export → import yields identical Markdown and, for full backups, identical CRDT history; server backup taken during concurrent writes restores to a consistent state (unit test against a temp dir).

---

## 3. Security

All of section 3 applies to `src/lib/server/sync-server.ts`, `src/server/main.ts` and, after item 7, the new room server.

### 3.1 Constant-time token comparison (item 3)

**Problem.** `sync-server.ts:118` (HTTP) and `:411` (WebSocket join) compare secrets with `!==`.

**Required change.** Add `src/lib/server/auth.ts` with `safeEqual(a: string, b: string): boolean`, which SHA-256 hashes both inputs and compares the digests with `crypto.timingSafeEqual`. Hashing first makes the lengths equal, so length leaks nothing. Use it everywhere a secret is compared, including the pairing and ticket checks from item 5.

**Acceptance.** Unit tests; `architecture.test.ts` (or a grep test) fails if `authToken` appears next to `===` / `!==` in `src/lib/server`.

### 3.2 Auth attempt limiting (item 4)

**Problem.** Unlimited guesses on the HTTP API and the WebSocket join.

**Required change.** In `auth.ts`, an in-memory limiter keyed by client IP: after 10 failures in 60 s, respond `429` with `Retry-After`; each further lockout doubles, capped at 15 minutes; a success resets the counter. Apply it to every authenticated entry point: `/api/*`, the pairing endpoints, and WebSocket join. Client IP is the socket address. Trust `X-Forwarded-For` only when `METHYL_TRUST_PROXY=true` (document it for the Nginx Proxy Manager setup in SPEC §32). Evict idle entries so memory stays bounded.

**Acceptance.** Unit tests with a fake clock for lockout, doubling, reset and eviction; an e2e-style server test that the 11th bad request gets 429.

### 3.3 Device pairing instead of a token in `localStorage` (item 5)

**Problem.** The sync token is stored in plain `localStorage` (`src/lib/browser/sync-config.ts`) and sent as a bearer token (`src/lib/browser/sync-host.ts:180`, `:206`). SPEC §31 specifies pairing.

**Required change** (implements SPEC §31, with names updated):

1. `METHYL_AUTH_TOKEN` becomes the **admin token**. It is used only to pair devices and for CLI/scripts. Keep the name for compatibility.
2. Server-level state lives in `<vaults dir>/.methyl-server/server.db` (see item 9). Table `devices(id, name, secretHash, vaults JSON, createdAt, lastSeenAt, revokedAt)`.
3. `POST /api/auth/pair` with the admin token and `{deviceName, vaults}` issues a random 256-bit device secret. The server stores only its SHA-256 and sets it as an `HttpOnly; Secure; SameSite=Strict; Path=/` cookie. `Secure` is omitted only when the request is plain HTTP from loopback (local development).
4. `POST /api/auth/ws-ticket` (cookie-authenticated) returns a random ticket valid for 60 s and usable once, scoped to one vault. The browser keeps it in memory and passes it as the WebSocket join auth payload.
5. All other `/api/*` routes accept the device cookie. They also accept the admin bearer token, for scripts.
6. `GET /api/auth/devices` and `DELETE /api/auth/devices/:id` (admin or same device) list and revoke devices. Add a *Devices* list to `SyncSettingsDialog.tsx`.
7. **Migration.** On startup, if `sync-config.ts` finds a stored token, call `/api/auth/pair` with it, then delete it from `localStorage` whether or not pairing succeeded (on failure, show the sync settings dialog asking for the admin token again).
8. **Cross-origin deployments** (`METHYL_ALLOWED_ORIGINS`) cannot use `SameSite=Strict` cookies. Document that browser sync requires the app and server on the same site. Keep the CORS allow-list for `/healthz` and admin-token scripts only.

**Acceptance.** No token is present in `localStorage`, IndexedDB or OPFS after pairing (e2e assertion). Tickets expire and are single-use. Revoking a device drops its open sockets within one heartbeat. The old-token migration is tested.

### 3.4 Input validation for IDs (item 6)

**Problem.** Asset and room IDs go from `decodeURIComponent` straight into SQLite keys and conflict IDs (`${id}~${digest}`). Disk paths use the sha256, so there is no traversal, but there are no length or character limits.

**Required change.** In `auth.ts`: room and asset IDs must use the alphabet the app actually produces — room IDs look like `doc:<uuid>` or `vault:<id>`, asset IDs are Loro tree IDs (`<counter>@<peer>`), optionally followed by `~` and 12 hex characters for conflict copies. Accept `[A-Za-z0-9][A-Za-z0-9:@._~-]*`, at most 128 characters, never containing `..`. Reject anything else, and any malformed percent-encoding, with `400` before touching the store. `after=` in `/api/changes` must be a non-negative safe integer. Keep the existing 512 MiB upload limit, but make it configurable with `METHYL_MAX_ASSET_BYTES`.

**Acceptance.** Table-driven tests: valid IDs, conflict IDs, empty, over-long, `..`, `/`, NUL, and percent-encoded variants.

---

## 4. Sync and vaults

### 4.1 Live sync with an in-house room server (item 7)

**Problem.** Remote edits arrive on the next discovery poll (`src/lib/sync/scheduler.ts:95`, 15 s) because `SimpleServer` can't push into a room that's already joined. The server works around `SimpleServer` three ways: an internal loopback port (`main.ts`, `INTERNAL_WS_PORT`), a byte-level TCP upgrade proxy (`handleUpgrade`), and writing into its private `rooms` map (`patchCachedRoomIfLoaded` in `sync-server.ts`).

**Required change.**

1. New `src/lib/server/room-server.ts`: a WebSocket server (`ws`, already a transitive dependency; add it explicitly) that speaks the same `loro-protocol` messages the client (`loro-websocket` client, `src/lib/sync/websocket.ts`) already uses. It attaches to the existing `http.Server` via `noServer: true` and `server.on("upgrade")`. No second port, no proxy.
2. Room state: one loaded `LoroDoc` per open room, evicted after the last client leaves plus a 60 s grace period. Load from and save to `ServerStore` as `onLoadDocument` / `onSaveDocument` do today.
3. **Push:** a public `applyUpdate(roomId, bytes, origin)` imports an update and broadcasts it to every client in the room except `origin`. Call it from client updates and from the vault watcher's ingest path (replacing `patchCachedRoomIfLoaded`), so disk edits reach open editors immediately.
4. **Discovery push:** a `changes` notification (seq only) sent on a per-vault control channel, so clients fetch `/api/changes` when told instead of every 15 s. Keep the poll as a fallback, raised to 60 s.
5. Auth: join uses the ticket from item 5, compared with `safeEqual` and rate-limited per item 4.
6. Remove `INTERNAL_WS_PORT`, `handleUpgrade`, the Next upgrade-listener removal loop in `main.ts`, and `patchCachedRoomIfLoaded`. Drop `loro-websocket`'s server import; keep its client only if still used.
7. Heartbeat: ping every 30 s and drop dead sockets.

**Acceptance.** Extend `src/lib/server/__tests__/sync-server.e2e.test.ts`: two clients in one room see each other's edits in under 1 s; an external disk edit reaches an already-open client in under 2 s (watcher debounce 300 ms plus margin); a rejoining client gets the latest snapshot. Tick the "Sync isn't live" entry in `TODO.md` and update SPEC §18–20 and §33.

### 4.2 Report the `loro-codemirror` bug upstream (item 8)

**Problem.** `LoroSyncPluginValue` swallows the first view update when the initial content already matches. `NoteEditor.tsx` works around it. The repro is `src/lib/editor/__tests__/loro-codemirror-swallow.test.ts`.

**Required change.** Reduce the repro to a standalone script with no Methyl imports, file the issue upstream, and link it from a comment above the workaround in `NoteEditor.tsx` and from `TODO.md`. Leave the workaround in place, and make the repro test fail loudly once upstream is fixed (it asserts the buggy behaviour), so the workaround gets removed then.

**Acceptance.** Issue link in code and `TODO.md`.

### 4.3 Multiple vault support (item 9)

**Problem.** Everything assumes one vault. The browser uses one fixed OPFS root (`ROOT_KEY = "adhd-vault"`, `src/lib/vault/opfs.ts:4`). The server takes one `METHYL_VAULT_PATH` (`src/server/main.ts:9`), and rooms, change log and assets share one namespace. `TODO.md` says SPEC covers multi-vault, but it doesn't.

**Data model.**

- A **vault** has `id` (random, stable, never shown), `name` (user-editable) and an optional server binding `{serverOrigin, remoteVaultId}`.
- Server vault IDs are the folder names under the vaults directory, restricted to `[a-z0-9][a-z0-9-]{0,62}`.

**Browser layout.**

```text
OPFS root
└── methyl/
    ├── vaults.json            registry: [{id, name, server?, createdAt}]
    └── vaults/
        └── <vaultId>/         what "adhd-vault/" holds today
            ├── <notes and folders>
            └── .methyl/
```

- Everything keyed per vault gets the vault ID in its key: Web Lock names (`src/lib/vault/web-locks.ts`), the sync config, the workspace store (`src/lib/workspace/store.ts`), the search index (`src/lib/search/index.ts`), the sidebar collapsed-folders key (`AppSidebar.tsx`), the graph layout store and the seed marker (`src/lib/browser/seed-marker.ts`).
- One tab has one vault open. Different tabs can have different vaults open, each with its own writer lock.
- The URL carries the vault: `/v/<vaultId>/<note path>`. `src/app/[...slug]/page.tsx` already catches all paths. Bare `/` opens the last-used vault.

**Browser UI.** A vault switcher at the top of the sidebar (`AppSidebar.tsx`), and in the command menu (*Switch vault*, *New vault*, *Rename vault*, *Delete vault*). Deleting a vault requires typing its name, and offers a full-backup export (item 2) first. The Obsidian importer gains *Import into a new vault*.

**Server layout.**

```text
/vaults                     METHYL_VAULTS_PATH (new)
├── .methyl-server/         server-level state: server.db (devices, tickets)
├── personal/               a vault
│   ├── <notes and folders>
│   └── .methyl/server/     that vault's SQLite db and assets (was .adhd/server/)
└── work/
```

- `createSyncServer` becomes per-vault. A new `VaultRegistry` in `src/lib/server/` scans `METHYL_VAULTS_PATH` at startup, and then watches it (non-recursively), to open and close vaults. Each vault has its own `ServerStore`, watcher and room namespace.
- HTTP routes gain a prefix: `/api/v/<vaultId>/changes`, `/durable/…`, `/assets/…`, `/rooms`. `GET /api/vaults` lists the vaults the caller's device may access. The WebSocket path becomes `/sync/<vaultId>`.
- Device authorisation is per vault (`devices.vaults` in item 5).
- **Compatibility:** if only `METHYL_VAULT_PATH` is set, serve that one folder as vault `default`. Keep the unprefixed `/api/*` routes as aliases for `default` for one release, and log a deprecation warning.

**Migration.**

1. *Browser:* on first start with the new code, if `adhd-vault/` exists and `methyl/vaults.json` doesn't, create a vault named "My vault", copy `adhd-vault/` into `methyl/vaults/<newId>/` (renaming `.adhd/` to `.methyl/` during the copy, item 13), verify file count and CRDT bytes, write `vaults.json`, then delete `adhd-vault/`. OPFS has no reliable cross-browser directory move, so always copy, verify, then delete. Carry the existing sync config across as that vault's server binding. Hold a migration Web Lock so only one tab migrates.
2. *Server:* see the compatibility rule above. Moving an existing `/vault` mount into `/vaults/<name>` is a documented manual step. The server never moves user folders by itself.

**Acceptance.** Unit tests for the registry, per-vault key namespacing and the migration (including a crash between copy and delete, then rerun). Server e2e test with two vaults: edits in one never show up in the other's changes feed, and a device paired for one gets 403 on the other. Playwright: create a second vault, switch, both vaults keep their notes across reloads, and two tabs hold writer locks on different vaults at once. Add a multi-vault section to SPEC.md and fix the `TODO.md` reference.

---

## 5. CI and repository hygiene

### 5.1 Lint in CI (item 10)

**Problem.** CI (`.github/workflows/docker.yml`) runs typecheck, unit and e2e tests, but not lint. `TODO.md` lists existing errors: `set-state-in-effect` and an unused `event` in `AppSidebar.tsx`, plus warnings in `engine.ts`, `store.ts` and `carousel.tsx`.

**Required change.** Fix the existing errors and warnings (no `eslint-disable` without a one-line reason). Add `npm run lint -- --max-warnings=0` to the CI `test` job, to `check:ci`, and to lefthook's pre-commit.

**Acceptance.** CI fails on a new lint warning.

### 5.2 One lockfile (item 11)

**Problem.** Both `package-lock.json` and `pnpm-lock.yaml` are committed. CI, Docker and lefthook all use npm.

**Required change.** Delete `pnpm-lock.yaml`. Add `"packageManager": "npm@<current>"` to `package.json`, and a CI step that fails if `pnpm-lock.yaml` or `yarn.lock` reappears.

### 5.3 Releases and a visible version (item 12)

**Problem.** There is no tag, `latest` follows `main`, and `NEXT_PUBLIC_APP_VERSION` is only set if someone sets it by hand.

**Required change.**

1. Tag `v0.1.0` once items 3–6 land. The Docker workflow already has semver tagging.
2. In the Docker workflow, `latest` follows the newest semver tag only. `main` keeps `edge` and `sha-*`.
3. Set `NEXT_PUBLIC_APP_VERSION` at build time: the tag if there is one, otherwise `0.0.0-<short sha>`. Pass it as a Docker build arg.
4. Show the version in the sync status popover and in the diagnostics summary. Return `{version}` from `/healthz`. The client warns when the client and server major.minor versions differ.
5. Add `CHANGELOG.md`.

**Acceptance.** An image built from a tag reports that tag in the UI and `/healthz`.

### 5.4 Finish the rename from "adhd" (item 13)

**Problem.** The old name remains in `package.json` (`"name": "adhd"`), the `.adhd/` metadata directory (reserved in `src/lib/core/paths.ts:38` and referenced in about 20 modules), the `adhd-vault` OPFS root, the `adhd-name`, `adhd-sync-config` and `adhd.sidebar.collapsedFolders` storage keys, the `cm-adhd-*` CSS classes, `adhdEditorExtensions`, and the SPEC.md title and environment variable names.

**Required change.**

1. Put the name in one place: `src/lib/core/paths.ts` exports `META_DIR = ".methyl"` and `LEGACY_META_DIRS = [".adhd"]`. Every module imports these; none hard-codes the string. Both names stay reserved (never shown or synced as user content).
2. Server startup: if a vault has `.adhd/` and no `.methyl/`, rename it (same filesystem, atomic `rename`). If both exist, refuse to start that vault and log how to resolve it.
3. Browser: done by the multi-vault migration (item 9).
4. Storage keys: rename to `methyl.*`, reading the old key once, writing the new one and deleting the old.
5. Rename code identifiers and CSS classes. Keep `ADHD_ID_COMMENT_RE` in `src/lib/core/doc-id.ts` as-is: it recognises the legacy `<!-- adhd:id=… -->` comment in old files and must keep matching them.
6. `package.json` name becomes `methyl`. SPEC.md: update the title and `ADHD_ADMIN_TOKEN` → `METHYL_AUTH_TOKEN`.

**Acceptance.** A grep test finds no `adhd` outside the migration code, `LEGACY_META_DIRS`, `ADHD_ID_COMMENT_RE` and its tests. Migration tests on the server for: only-old, only-new and both.

---

## 6. Maintainability

### 6.1 Split the largest files (item 14)

**Problem.** `src/components/vault/VaultApp.tsx` (1,574 lines), `src/lib/vault/engine.ts` (1,527) and `src/components/vault/AppSidebar.tsx` (1,478) are hard to review and test. The engine is where the item 1 bug most likely lives.

**Required change.** Pure refactors, one file per PR, with behaviour unchanged and existing tests passing untouched:

- `engine.ts` → `engine/` folder: `tree-ops.ts` (create/rename/move/delete), `ingest.ts` (`ingestExternalChanges` and its safety rails), `materialise.ts` (Markdown writes), `index-repair.ts`, and a thin `engine.ts` facade that keeps the current public API. Do this **after** item 1's deletion audit, so the audit function exists before code moves around it.
- `AppSidebar.tsx` → tree rendering, drag-and-drop wiring (logic already partly in `sidebar-dnd.ts` and `sidebar-order.ts`), folder context menus, and the vault switcher from item 9.
- `VaultApp.tsx` → a hooks module (vault boot, sync wiring, save feedback), `VaultPluginBridge` in its own file, and the header.

No file over ~600 lines afterwards. Add that as a soft check in `architecture.test.ts` (warn, list offenders).

### 6.2 Remove unused UI components (item 15)

**Problem.** `src/components/ui/` has 62 shadcn components; about 25 are imported outside that folder.

**Required change.** Delete every component in `src/components/ui/` that nothing outside that folder imports, directly or through another used component. Then remove the npm dependencies that become unused (candidates: `recharts`, `embla-carousel-react`, `input-otp`, `react-day-picker`; check each with a grep). `npx shadcn add` can bring any component back later.

**Acceptance.** Typecheck, unit and e2e tests pass; `npm ls` shows the removed packages gone; the client bundle gets smaller (record before/after in the PR).

---

## 7. Product quality

### 7.1 Real-device testing (item 16)

**Problem.** Mobile is covered only by Chromium emulation; offline behaviour is verified only in desktop Chrome.

**Required change.** Add `docs/qa/device-checklist.md` covering: install as PWA; offline read/write after the server is stopped; the iOS storage eviction and background limits from SPEC §15 and §41; keyboard overlap with the editor; safe-area insets; press-and-hold drag in the sidebar; the edge-swipe gesture; sync resume after the app was backgrounded. Run it on a current iPhone (Safari and installed PWA) and a current Android phone (Chrome), and record the results with the version and device in the same file. File each failure as its own `TODO.md` entry. Repeat the checklist before each minor release.

### 7.2 Accessibility pass (item 17)

**Required change.**

1. Add `@axe-core/playwright` and an e2e spec that runs axe on: the empty vault, a note open, the command menu, the quick switcher, sync settings, the templates dialog and the vault switcher. No serious or critical violations.
2. Keyboard-only e2e: create a note, rename it, move it to another folder, open it in a split, and switch vaults, all without a pointer.
3. **Keyboard move:** a *Move to…* command (command menu and note context menu) that opens a folder picker, so moving between folders doesn't need drag-and-drop.
4. Check focus order and focus return for every dialog and sheet. Check sidebar tree semantics (`role="tree"`, `aria-expanded`, arrow-key navigation).
5. A manual pass with VoiceOver (macOS and iOS), recorded in the device checklist from 7.1.

### 7.3 Editor features (item 18)

Build these in this order; each is its own PR with unit tests for the CodeMirror extension and one e2e test:

1. **Paste and drop images and files.** Store them with the existing attachments module (`src/lib/vault/attachments.ts`) and insert a Markdown link at the cursor, or at the drop position. Name pasted images `Pasted image <timestamp>.png` in the note's folder (Obsidian's convention, so imported vaults stay consistent).
2. **Smart paste.** A URL pasted over a selection becomes `[selection](url)`. HTML is converted to Markdown with the `unified`/`remark` stack already in use (add `rehype-parse` and `rehype-remark`). Holding Shift pastes plain text.
3. **Slash menu.** `/` at the start of a line or after whitespace opens a `@codemirror/autocomplete` source with: headings 1–3, bullet, numbered and task lists, table, code block, quote, divider, today's date, and templates. Reuse the wikilink autocomplete's structure (`src/lib/editor/wikilink-autocomplete.ts`). The plugin system should be able to add entries.
4. The remaining `TODO.md` editor items (table helpers, block drag handle, wikilink modifier hint, selection colour) stay in `TODO.md` and are out of scope here.

### 7.4 Smaller Docker image (item 19)

**Problem.** The image is 464 MB, mostly the Debian base, Node and `better-sqlite3`.

**Required change.** Keep the multi-stage build. For the runtime stage, try in order: `gcr.io/distroless/nodejs24-debian12` (copying the prebuilt `better-sqlite3` binary from the build stage), then `node:24-alpine` (only if `better-sqlite3` builds or has a prebuilt binary for musl). Copy only `dist/`, `.next/` (without `.next/cache`), `public/` and the production dependencies that `build:server` marks external. Run as a non-root user. A distroless image has no shell, so the backup command from item 2 must run as `node dist/server.cjs backup …`.

**Acceptance.** Image under 250 MB; the Docker build check (`npm run check:docker`) passes; a container started from the new image serves the app and `/healthz` answers from the new image; the vault volume is still writable as the non-root user (document the `chown` step for existing installs).

---

## 7.5 PWA startup time (item 20)

**Problem.** Reported in use: an installed PWA on iOS Safari takes about 5 seconds to become usable, even though the app shell and the vault are already on the device. For an offline-first app that should open like a native one, that is the most visible performance problem.

**Required change.**

1. **Measure first.** Add `performance.mark()` calls at: first script execution, React hydration, vault open (OPFS root and tree loaded), index/search ready, first note rendered, and writer lock acquired. Record them in the diagnostics buffer and show them in "Copy diagnostics". Take a baseline on a real iPhone (installed PWA, cold start, warm cache) and on desktop Chrome with 4× CPU throttling, and record the numbers in this section.
2. **Get the shell on screen immediately.** The sidebar, the last-open note's title, and the note text (from a small cached copy) should render before the full vault has opened. Anything not needed for the first screen (graph editor, Mermaid, KaTeX, the plugin dialogs, recharts) is loaded lazily, not in the entry bundle.
3. **Don't rebuild what can be cached.** The search index and backlinks are derived state (SPEC §3). Persist them to OPFS with the vault version they were built at; on startup, load the saved copy and update it incrementally in the background instead of rebuilding it before the UI is interactive.
4. **Cut the OPFS round-trips on the critical path.** Load the tree snapshot and the sidecar index in parallel. Don't read every document's CRDT state at startup; open documents lazily when they are first shown or searched.
5. **Service worker:** serve the app shell cache-first so a warm start makes no network request before first paint, including when the sync server is unreachable.

**Measured so far** (`scripts/measure-startup.mjs`: a 400-note vault synced into OPFS, desktop Chromium, 4× CPU throttling, warm reloads, time to `methyl:engine-ready`):

| | Before | After |
| --- | --- | --- |
| Modules + Loro WASM | 0.3–1.6 s | same |
| Load 400 documents | ~6 s (blocking) | background |
| Startup reconcile | ~9–11 s (blocking) | background, and cheaper |
| **Engine ready** | **~18.5 s** | **~1.1 s** |
| First sync of the 400 notes | stalled (123 after 4 min) | completes |

The Loro WASM compile (3.2 MB) was not the main cost here; the document loading, reconcile and quadratic indexing were. Starting the WASM compile earlier (at module evaluation) was tried and gave no gain in Chromium — it only delays hydration — so it was not kept. A real-iPhone measurement is still needed (step 1).

**Acceptance.** Warm-cache cold start to an interactive, editable last-open note in **under 1 second** on a recent iPhone and under 500 ms on desktop Chrome, recorded with the marks from step 1. A Playwright test with CPU throttling guards against regressions (for example, at most 2 s to an editable note with 4× throttling and a 500-note vault).

## 7.6 Found while implementing: sync data-loss bugs

Chasing flaky sync tests during phase A turned up four ways the server could lose edits. They were fixed in phase A because they are data loss, and each is covered by a test that fails without the fix:

- A client save rewrote a note file without checking for an un-ingested external edit, overwriting it for good.
- The three-way merge used the wrong base (the persisted state's frontiers, not the version written to disk), so an external edit could replace unsaved CRDT text.
- The shrink safety rail compared the disk file with the CRDT's current text rather than with what was last written, so it refused genuine external additions.
- Publishing an ingested snapshot replaced the live room's cached document, dropping client updates it had received but not yet saved.

A sync round also now waits until the server's durable version covers the client's version before leaving a room (SPEC §20).

## 8. Order of work

Items in the same phase can run in parallel.

| Phase | Items | Why this order |
| --- | --- | --- |
| A — quick safety | 3, 4, 6, 10, 11 | Small, independent and immediately useful. Lint in CI stops regressions during the larger work. |
| B — data safety | 1, then 2 (export only) | The wipe investigation must come before the engine is refactored or the on-disk layout changes. |
| C — layout | 13 + 9 together, then 2 (full-backup import into a new vault) | Both change on-disk layout; one migration is safer than two. |
| D — auth and sync | 5, then 7 | Tickets from item 5 are the join auth for the new room server. Vault-scoped routes from item 9 must exist first. |
| E — release | 12 | Tag `v0.1.0` after phase D. |
| F — structure | 14, 15 | 14 after item 1 (see 6.1). 15 is independent and can move earlier. |
| G — quality | 16, 17, 18, 19, 20 | Can start any time; 16 and 17 should cover the vault switcher, so run them after phase C. 20 (startup time) should be measured before phase C changes the storage layout, and re-measured after. |

## 9. Verification for the whole programme

- `npm run check:ci` (typecheck, unit, e2e) and `npm run lint -- --max-warnings=0` pass on every PR.
- `npm run check:docker` passes for items that touch the server, Dockerfile or build.
- Upgrade test before tagging `v0.1.0`: take a vault created on `ae75f3d` (browser and server), upgrade to the release, and confirm every note, attachment, CRDT history and the sync pairing survive, with no leftover `.adhd/` or `adhd-vault/`.
