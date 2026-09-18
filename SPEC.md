# ADHD v4 Architecture Specification

## 1. Product goal

ADHD is a self-hostable, Obsidian-style Markdown application built with Next.js.

It must:

* work fully offline on iPhone, desktop and other modern browsers
* keep the complete vault available offline
* use normal folders, Markdown files and arbitrary supporting files
* keep the server vault human-readable and usable with normal filesystem tools
* allow folders such as `.assets/`, `_resources/`, `Attachments/`, etc.
* permit editing the server vault outside ADHD with tools such as VS Code
* allow edits on multiple devices while disconnected
* automatically reconcile those edits when the home server becomes reachable
* require no Postgres, Redis, MinIO or other infrastructure
* be deployable as one Docker container plus one mounted vault volume
* preserve user data even if ADHD itself is abandoned

The core philosophy is:

> Markdown and normal files are the portable data format. Loro is the synchronization/history format. Everything else is disposable derived state.

---

# 2. Final technology stack

| Layer                   | Choice                                                 |
| ----------------------- | ------------------------------------------------------ |
| Application             | Next.js 16, React, TypeScript                          |
| Deployment              | Next.js server (single-port container)                |
| UI                      | Tailwind CSS 4, shadcn/ui, next-themes                 |
| Markdown editor         | CodeMirror 6                                           |
| Editor/CRDT integration | `loro-codemirror`                                      |
| CRDT                    | Loro 1.x, pin tested release                           |
| Vault hierarchy         | `LoroTree`                                             |
| Markdown contents       | one `LoroText` document per `.md`                      |
| Sync transport          | official `loro-websocket` protocol                     |
| Browser filesystem      | native OPFS                                            |
| Browser coordination    | Web Locks API                                          |
| Search                  | MiniSearch                                             |
| Markdown analysis       | unified/remark ecosystem                               |
| Hashing                 | SHA-256, incremental implementation for large files    |
| PWA                     | custom service worker built with Serwist build tooling |
| Server runtime          | Node.js 24 LTS                                         |
| Server SQLite           | `better-sqlite3`                                       |
| Filesystem watching     | Chokidar 5                                             |
| Graph editor            | `@xyflow/react` / React Flow                           |
| Mermaid export          | Mermaid                                                |
| Optional ZIP export     | fflate                                                 |

Node 24 is currently Active LTS in September 2026. I would use it rather than Node 26 until 26 reaches LTS.

`better-sqlite3` remains extremely widely deployed and mature, whereas Node's built-in `node:sqlite` is still marked release candidate rather than stable.

---

# 3. Data model: three kinds of truth

ADHD deliberately distinguishes three layers.

### Portable truth

The user's files:

```text
/vault/
├── Inbox/
├── Notes/
│   ├── Garage.md
│   └── Shopping.md
├── Projects/
│   └── ADHD/
│       ├── Architecture.md
│       └── .assets/
│           └── architecture.png
├── Journal/
│   └── 2026-09-16.md
├── Attachments/
└── .adhd/
```

If the user backs up everything except `.adhd/`, their notes and files still survive.

### Merge/history truth

Loro CRDT state.

It answers questions such as:

* what happened while two devices were offline?
* which edits are concurrent?
* how should text merge?
* was a file moved while another device edited it?
* what was the previous version?

Deleting the Loro state loses CRDT history but must **not** lose the current Markdown content.

### Derived state

Things ADHD can reconstruct:

* search index
* backlinks
* tags index
* graph index
* recent-file cache
* server change-discovery SQLite
* thumbnails

Deleting derived state is always safe.

---

# 4. Vault structure

The server filesystem is the human-readable vault.

Example:

```text
/vault/
├── Inbox/
│   └── Buy new switch.md
│
├── Home/
│   ├── Garage.md
│   └── .assets/
│       ├── garage-before.jpg
│       └── dimensions.png
│
├── Projects/
│   └── ADHD/
│       ├── Architecture.md
│       └── Ideas.md
│
├── .trash/
│
└── .adhd/
    ├── server/
    │   ├── sync.sqlite
    │   └── rooms/
    │       ├── vault.loro
    │       └── docs/
    │           ├── 0199....loro
    │           └── 0199....loro
    │
    └── views/
```

Only two names are reserved at vault root:

```text
.adhd
.trash
```

Other dot-directories are valid user content:

```text
.assets/
.resources/
.templates/
```

ADHD should not impose a fixed attachment structure.

A setting controls where newly pasted/imported assets go, with sensible choices such as:

```text
Attachments/
same folder
.assets/
.assets/<note-name>/
```

Existing relative paths are always respected.

---

# 5. Document identity is not the pathname

A document must retain identity across:

```text
rename
move
offline rename
Git checkout
external filesystem move
```

Each Markdown document therefore receives a UUIDv7.

I would **not** clutter normal frontmatter with an application-specific property.

`.md` files stay 100% clean: no ADHD-specific marker of any kind, ever — not
in frontmatter, not as an HTML comment, not in the editor's LoroText, not on
disk. A vault file must be indistinguishable from one nobody's app has ever
touched, so it stays usable in any other Markdown tool, unmodified by
ADHD merely opening it.

Identity instead lives in two places, neither of them the file content:

```text
inside the app     → the vault-tree CRDT (LoroTree node → documentId)
outside the app     → a hidden sidecar index, .adhd/index.json
(disk reconciliation)
```

The vault tree (§6) is authoritative while ADHD is running: every tree node
already carries a stable `documentId`, so renames and moves performed
through the app never touch identity at all.

The sidecar index exists for the case the tree can't cover: reconciling
changes made *outside* ADHD (a disk watcher, a server rescan, crash
recovery). It's a flat map, written to `.adhd/index.json` next to the
existing `.adhd/crdt/` layout (§10):

```ts
// .adhd/index.json
type DocIndex = Record<
  string, // relative path
  {
    id: string; // UUIDv7
    contentHash: string; // sha256 of the clean file content
    size: number;
    mtime: number;
  }
>;
```

Reconciling a filesystem snapshot against the previous index follows these
rules:

```text
path known (still in the index)                → same id; ordinary edit
unknown path, hash matches a path that's        → move; id preserved
  now MISSING from the snapshot
unknown path, hash matches a path that's        → copy; fresh id
  STILL PRESENT in the snapshot
unknown path, no hash match, no legacy marker   → new document; fresh id
indexed path missing, not claimed by a move     → deletion
```

Implemented by `reconcileVault()` in `src/lib/core/doc-index.ts`, wired into
the engine by `VaultEngine.ingestExternalChanges()`
(`src/lib/vault/engine.ts`): it scans materialised `.md` files, reconciles
them against the index, and applies the result — a changed known file is
three-way merged into the LoroText (`mergeExternalEdit`, §24), a move
updates the tree (creating folders as needed) and keeps the id, a copy or
new file creates a fresh document, and a deletion removes the tree node.

Boot order matters: `VaultEngine.reconcileMaterialization()` always calls
`ingestExternalChanges()` *first*, before its own "re-materialise stale /
delete orphaned" pass — otherwise that pass would treat disk as pure
*output* and either silently overwrite an external edit or delete a
genuinely new external file as an "orphan". The doc index's `contentHash`
is exactly the marker that tells the two apart: every app write
(materialize/repair/move) updates it immediately, so on the next scan
disk-matches-index means "our own write, nothing to ingest" and
disk-differs-from-index means "something external happened while ingest
wasn't watching."

On the Node server, `watchVaultForExternalChanges()`
(`src/lib/server/vault-watcher.ts`) debounces a chokidar watch over the
vault directory (ignoring `.adhd/` and `*.tmp`) and calls
`ingestExternalChanges()` on change, reporting affected `doc:<id>` /
`vault:<id>` rooms so the result can be broadcast to sync clients. In the
browser, OPFS has no external writers besides other tabs, so ingestion only
runs at boot and when the tab regains visibility.

**Migration.** Vaults created before the sidecar index exist still contain
the old `<!-- adhd:id=... -->` comment. On first read of such a file, ADHD:

```text
1. recovers the id from the comment
2. strips the comment from the content
3. rewrites the file on disk, now clean
4. records path → id in the sidecar index
5. if the id is already loaded into a LoroText, the same strip happens
   there too, as a normal one-time edit — the editor never shows the
   comment again
```

If two legacy files claim the same id (a `cp` made before the sidecar index
existed), the first one read keeps it; the second is treated as an
unmatched new file and gets a fresh id, exactly like the ordinary
external-copy case above.

Semantic user metadata remains normal frontmatter:

```yaml
---
tags: [home, garage]
status: blocked
due: 2026-09-30
deps:
  - "[[Tip Visit]]"
  - "[[Hana Help]]"
---
```

App presentation state does **not** belong there.

For example, graph coordinates belong in ADHD's view state rather than:

```yaml
graph:
  x: 123
  y: 456
```

---

# 6. Folder/file hierarchy CRDT

One small Loro document represents the vault hierarchy:

```text
room: vault:<vault-id>
```

It contains a `LoroTree`.

Loro specifically designed its movable-tree CRDT for hierarchical structures such as file directories and prevents cycles during concurrent moves.

Conceptually:

```text
ROOT
├── Notes
│   ├── Garage.md
│   └── Shopping.md
└── Projects
    └── ADHD
        └── Architecture.md
```

Each node contains only structural metadata:

```ts
{
  id: stableNodeId,
  name: "Garage.md",
  kind: "markdown" | "binary" | "directory",
  documentId?: "0199..."
}
```

The tree does **not** contain Markdown contents.

The tree also does not change every time somebody types a character.

---

# 7. One CRDT document per Markdown note

Every Markdown note gets a separate room:

```text
doc:<document-id>
```

containing:

```ts
doc.getText("content")
```

That `LoroText` contains the **entire raw Markdown file**.

Not JSON.

Not parsed blocks.

Not a proprietary document format.

For example:

```md
---
tags: [project]
status: active
---

# Architecture

The local vault is stored in OPFS.
```

This means:

```text
LoroText
    ⇅
raw .md
```

The Markdown parser is only used to derive:

```text
headings
links
wikilinks
frontmatter
tags
backlinks
graph edges
search text
```

ADHD must never round-trip normal note edits through a Markdown AST.

---

# 8. CodeMirror integration

Use the official `loro-codemirror` binding.

It already provides:

* CodeMirror 6 ↔ Loro synchronization
* CRDT-aware undo/redo
* cursor/selection awareness

and is maintained under the Loro organisation.

This is preferable to implementing a custom editor synchronization layer.

Loro's own UndoManager is specifically designed so that a user's undo removes their own local operations rather than undoing somebody else's concurrent edit.

---

# 9. iPhone/browser storage

The browser replica uses **native OPFS**.

Do not make ZenFS a required layer.

OPFS is supported by modern Safari/iOS, and synchronous access handles can run inside dedicated workers for efficient filesystem I/O. Their `flush()` operation explicitly persists written changes to disk.

The browser's OPFS mirrors the logical vault:

```text
/vault/
├── Inbox/
├── Notes/
├── Projects/
├── Attachments/
├── .trash/
└── .adhd/
    ├── device/
    ├── crdt/
    │   ├── vault/
    │   └── docs/
    └── cache/
        ├── search.json
        └── backlinks.json
```

Unlike the server copy, the iPhone OPFS files are not directly exposed in the Files app.

That is acceptable because the server copy is the portable filesystem.

---

# 10. Local CRDT persistence

Do not export an entire Loro snapshot after every keystroke.

Loro explicitly supports the appropriate pattern:

```text
snapshot
+
incremental updates
+
periodic compaction
```

and validates checksums when importing snapshots/updates.

Per document:

```text
.adhd/crdt/docs/<id>/
├── snapshot.loro
├── updates/
│   ├── 000001.loro
│   ├── 000002.loro
│   └── 000003.loro
└── state.json
```

On an editing flush:

```text
CodeMirror transaction
        ↓
Loro commit
        ↓
export incremental update
        ↓
write update to OPFS
        ↓
flush()
        ↓
materialise Markdown
        ↓
update materialisation checkpoint
```

The CRDT operation is persisted before the materialized Markdown representation.

That means a crash between those two stages cannot lose the edit: startup can regenerate the `.md` file from Loro.

Compact local updates into a new snapshot when one of these occurs:

```text
100 update segments
1 MiB update data
24 hours since previous compaction
```

These are tuning values, not format requirements.

---

# 11. Crash-safe Markdown writes

Markdown writes use:

```text
foo.md.tmp
    ↓
flush
    ↓
move/replace
    ↓
foo.md
```

File moves are supported by current Safari/iOS; support for file moves is also broadly available elsewhere.

More importantly, the Loro update has already been persisted first.

So even if replacement fails halfway through:

```text
Loro state = correct
foo.md = old or incomplete
```

startup detects the mismatch and repairs the Markdown.

Every materialisation checkpoint stores:

```text
document id
Loro frontiers/version
SHA-256 of materialized Markdown
```

Invariant:

> When a note is clean, SHA256(materialized LoroText) equals SHA256(the `.md` file).

---

# 12. Browser single-writer protection

Multiple tabs must not independently mutate the same OPFS vault.

Acquire:

```text
navigator.locks.request(
  "adhd-vault:<vault-id>:writer"
)
```

The Web Locks API is broadly supported, including Safari/iOS since 15.4.

One window becomes the vault writer.

A second window can:

```text
open read-only
request takeover
focus existing window
```

This avoids same-device filesystem races while still allowing multiple physical devices to edit concurrently through Loro.

Each Loro session uses its own peer ID.

Do not persist/reuse a Loro PeerID between simultaneously active sessions; Loro explicitly warns this can cause document divergence.

---

# 13. Client search: no SQLite

Do not use SQLite-WASM in the browser unless actual scale later proves it necessary.

Use MiniSearch.

It currently has roughly 2.5 million weekly npm downloads and supports browser use, full-text indexing, fuzzy/prefix search and serialization.

Derived document:

```ts
{
  id,
  title,
  path,
  body,
  tags,
  aliases,
  headings
}
```

Index fields with weighting roughly:

```text
title        5
aliases      4
tags         3
headings     2
body         1
```

The search index is written to:

```text
.adhd/cache/search.json
```

Backlinks and other small indexes can be plain serialized maps.

Deleting `.adhd/cache/` triggers a rebuild from Markdown.

If ADHD eventually contains tens or hundreds of thousands of notes and MiniSearch becomes inadequate, client SQLite can be reconsidered without changing the vault or sync architecture.

---

# 14. Full offline mirror

Your requirement is stronger than "offline notes."

The iPhone should contain **every file** by default:

```text
Markdown
images
PDFs
attachments
other resources
```

Initial provisioning therefore has a distinct state:

```text
Downloading vault
1,842 / 2,013 files
384 MB / 427 MB
```

Only after all files have been downloaded and hashes verified does ADHD report:

```text
✓ Available completely offline
```

Before downloading, call:

```ts
navigator.storage.estimate()
navigator.storage.persist()
```

WebKit supports persistent storage requests and excludes persistent origins from ordinary eviction behaviour; installed Home Screen web apps are one of the factors WebKit considers when deciding whether to grant persistent mode.

If persistence is not granted:

```text
⚠ Offline storage is not protected from automatic eviction.
```

ADHD should not hide that condition.

---

# 15. iOS limitation: closed apps cannot guarantee sync

A pure web app cannot guarantee:

```text
arrive home
↓
iOS wakes closed ADHD
↓
sync
```

Safari/iOS still does not support the Background Sync API used for this pattern.

The supported behaviour is:

```text
ADHD already open
↓
home server becomes reachable
↓
automatic reconnect + sync
```

or:

```text
ADHD closed
↓
arrive home
↓
open ADHD
↓
immediate sync
```

This is the only significant platform limitation in the proposed architecture.

The UI must therefore distinguish:

```text
✓ Saved locally
● 7 changes waiting for home server
✓ Synced to server
```

Never label a locally saved note simply "Synced."

---

# 16. PWA shell

Next.js is used as a build/framework layer, and — since dynamic route params
(`/<vaultId>/<vault path>`) must resolve in a real path URL, which a static
export refuses for unlisted params — as the in-process server too, run
inside `src/server/main.ts` alongside the sync server behind one public port.
`next()` (the custom-server API) serves the app via `getRequestHandler()`;
the sync HTTP API, `/healthz`, and the sync WebSocket live in the same
process. No `output: "standalone"` build — that mode forbids custom-server
usage and would double the build pipeline.

The application's main workspace is a client shell. The open note lives in
the URL as a real path:

```text
/<vaultId>/<vault path>   e.g. /local/Projects/welcome.md
```

`src/app/[...slug]/page.tsx` is a normal dynamic route — no
`generateStaticParams` — that renders the same client shell for every path;
the shell resolves the note from the URL in the browser (no per-note server
data). That guarantees every possible note can be opened, including a hard
load of a deep URL, without a statically generated route existing for it.

---

# 17. Service worker

Do not put vault data in the service worker Cache API.

The service worker caches only:

```text
HTML app shell
JS chunks
CSS
fonts
icons
editor workers
WASM/runtime assets
```

The vault stays in OPFS.

Build the service worker independently from the Next integration layer using Serwist build tooling.

There have been multiple Next 16/Turbopack integration changes/issues around Serwist during 2026, so separating the SW build from Next reduces coupling.

Build:

```text
next build
      ↓
.next/server, .next/static

service-worker build
      ↓
precache .next/static + public/, plus "/" (the prerendered app shell) by URL
```

Navigation always falls back to the locally cached `/` document — every
route (including deep note URLs served by the dynamic `[...slug]` route)
renders the same client shell, so one cached document covers all of them
offline.

All required runtime assets must be self-hosted.

No Google Fonts CDN or other required third-party web resources.

---

# 18. Sync topology

There are three categories of synchronized state.

### Vault structure

```text
vault:<vault-id>
```

LoroTree.

### Markdown

```text
doc:<document-id>
```

LoroText.

### UI views that should follow the user

For example:

```text
view:<vault-id>:graph
```

A small Loro document containing things such as:

```text
node positions
collapsed groups
saved graph views
```

This prevents UI layout state from polluting Markdown frontmatter.

The official Loro protocol can multiplex many rooms over one WebSocket connection, so thousands of note rooms do not imply thousands of sockets.

---

# 19. Loro collection discovery

Loro deliberately handles **document synchronization**, not collection-level discovery.

Do not work around that by putting every note into one giant Loro document.

Instead use:

```text
LoroTree
    = which documents exist

client dirty journal
    = which local documents changed

server SQLite change sequence
    = which server documents changed
```

The server maintains a monotonically increasing integer:

```text
server_seq
```

Every time a room or binary asset becomes durably persisted:

```text
server_seq++
```

and inserts:

```text
changes(
  seq,
  object_id,
  type,
  timestamp
)
```

Client stores:

```text
last_server_seq
```

Reconnect:

```text
connect
  ↓
sync vault tree
  ↓
GET /api/changes?after=<last_server_seq>
  ↓
server-changed IDs
  +
local dirty IDs
  +
new IDs discovered through merged tree
  ↓
sync only that union
```

This avoids joining every note room every time the phone reconnects.

---

# 20. Durable sync semantics

This is a critical rule.

The Loro v1 protocol ACK means the server **accepted** an update. It does not inherently guarantee the application's persistence hook has already fsynced that update. The stock SimpleServer saves dirty documents periodically.

Therefore:

```text
WebSocket ACK
≠
durably synced
```

Each locally changed room records:

```text
roomId
target Loro VersionVector
```

in the local dirty journal.

Server persistence stores its latest durable VersionVector.

A local dirty entry is cleared only when:

```text
server durable version
        dominates
local target version
```

Then and only then:

```text
✓ Synced
```

If the server crashes after accepting an update but before persistence:

```text
client still considers room dirty
↓
server restarts
↓
client reconnects
↓
local Loro version is ahead
↓
missing operations are resent
```

This closes an otherwise subtle data-loss window without modifying the Loro wire protocol.

---

# 21. Server persistence

Use the official Node `SimpleServer` protocol implementation with its auth/load/save hooks rather than creating a custom CRDT protocol. The server exposes persistence callbacks and supports the same multiplexed/fragmented protocol as the client.

Run its persistence interval at approximately:

```text
500-1000 ms
```

rather than the default 60 seconds.

When `onSaveDocument()` fires:

```text
Loro room
    ↓
write snapshot.tmp
    ↓
fsync snapshot.tmp
    ↓
rename → snapshot.loro
    ↓
materialize filesystem if required
    ↓
fsync materialized file
    ↓
SQLite transaction:
    update durable version
    increment server_seq
    insert change row
```

SQLite metadata is updated **last**.

Therefore SQLite never claims a version is durable until its associated persistent files have been written.

Run SQLite with:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
```

The write volume is tiny enough that durability is more valuable than maximizing throughput.

---

# 22. SQLite's role

SQLite is **not the vault**.

It stores things such as:

```text
global server sequence
durable room versions
materialized hashes
asset hashes
change log
paired-device sessions
schema version
```

Example conceptual tables:

```text
meta
rooms
assets
changes
sessions
```

The server must be able to rebuild SQLite by scanning:

```text
Loro room snapshots
+
vault files
```

If `sync.sqlite` disappears:

```text
stop server
rebuild
force clients through full discovery
continue
```

No content is lost.

---

# 23. Server filesystem watcher

The mounted filesystem is intentionally editable outside ADHD.

Use Chokidar 5 rather than raw `fs.watch`.

Chokidar normalizes add/change/unlink events and specifically handles common editor behaviours such as atomic writes and chunked writes.

Watch:

```text
/vault/**
```

excluding:

```text
/vault/.adhd/**
/vault/.trash/**
```

Batch filesystem events for roughly 200-500 ms.

This makes operations such as:

```text
git checkout
git pull
bulk rename
VS Code save
```

appear as one reconciliation batch rather than hundreds of independent user-visible changes.

---

# 24. External Markdown editing: true three-way merge

This is the correct external-edit algorithm.

Suppose the server last materialized:

```text
BASE
```

Then:

```text
phone independently edits BASE → CURRENT
VS Code independently edits BASE → EXTERNAL
```

Do **not** do:

```text
currentLoroText.update(EXTERNAL)
```

because CURRENT contains phone changes that were not present when the external editor started.

Instead store the Loro version corresponding to the last materialized Markdown.

When an external edit is detected:

```text
mainDoc = latest Loro state

baseVersion = version used for last disk materialization

externalBranch =
    mainDoc.forkAt(baseVersion)

externalBranch.text.update(
    externalMarkdown
)

externalBranch.commit()

externalOps =
    export operations after baseVersion

mainDoc.import(externalOps)
```

The result is:

```text
BASE
├── phone branch
└── filesystem branch

       ↓ Loro

merged result
```

Loro supports forking at historical versions, version vectors and incremental exports specifically for this kind of versioned operation.

This is substantially safer than implementing our own LCS-based conflict system.

---

# 25. External renames and moves

Because the sidecar index (§5) tracks stable ids by content hash, not path:

```text
Notes/Garage.md

→

Projects/Home/Garage Plan.md
```

is discoverable as:

```text
same document (hash matches a path now missing from the index)
different path
```

The server updates the matching LoroTree node — the `.md` file itself is
never rewritten to carry identity.

For an atomic editor rename that appears as:

```text
unlink old path
add new path
```

hold deletion events briefly.

If an added Markdown document's content hash matches a path that just
disappeared:

```text
treat as move/rename, keep the indexed id
```

rather than:

```text
delete + create
```

---

# 26. External copies

If somebody does:

```bash
cp Garage.md Garage-copy.md
```

both files have identical content, and neither carries any ADHD marker —
identity lives in the sidecar index (§5), not in the file.

`reconcileVault()` detects this from content hashes alone:

```text
new path's hash matches a path still present in the index
    ↓
copy, not move
```

The original path keeps its indexed id unchanged. The copy is assigned a
fresh UUIDv7 and recorded in the index under its own path — the `.md` file
itself is never touched or rewritten to hold an id.

No user intervention is required.

---

# 27. External deletion

Deletion is modeled as a tree deletion/tombstone.

Loro's tree model handles deletion through its tree semantics rather than requiring the document contents to disappear from CRDT history immediately.

ADHD defaults to recoverable deletion:

```text
delete note
    ↓
logical tree deletion
    ↓
physical content → .trash/
```

CRDT history can be retained for a configurable period.

A concurrent text edit does not silently resurrect a deleted file.

The user can explicitly restore it.

---

# 28. Binary files

Do not put these through LoroText:

```text
PNG
JPEG
PDF
video
ZIP
audio
arbitrary blobs
```

They use:

```text
stable tree node ID
+
SHA-256
+
ordinary byte transfer
```

Use stable object IDs in the sync API rather than paths.

For example:

```http
GET /api/assets/<node-id>
PUT /api/assets/<node-id>
```

The path comes from the LoroTree.

This avoids rename races and avoids exposing path traversal through the HTTP API.

---

# 29. Binary conflict policy

Binary files cannot generally be merged.

Upload includes:

```text
baseHash
newHash
```

If:

```text
serverHash == baseHash
```

replace normally.

If:

```text
serverHash != baseHash
AND
serverHash != newHash
```

there were concurrent binary modifications.

Never use last-write-wins.

Create:

```text
diagram.png
diagram (conflict 0199abc).png
```

and add the second file to the vault tree.

No data is discarded.

---

# 30. Filename/path policy

Use portable filesystem rules even if the server currently runs Linux.

Within each directory:

* compare names case-insensitively for collision detection
* normalize Unicode to NFC
* reject `/` and `\`
* reject control characters
* reject Windows-invalid characters
* reject reserved Windows names such as `CON`, `NUL`, `COM1`
* reject trailing spaces and dots

This makes future export to:

```text
Windows
macOS
Linux
NAS
Git repository
```

predictable.

If concurrent tree operations create the same filename:

```text
Report.md
Report.md
```

resolve deterministically.

The node with the lowest stable node ID keeps:

```text
Report.md
```

The other becomes:

```text
Report (conflict a31f).md
```

The server writes that resolution back into the tree CRDT so all devices converge on the physical filesystem-compatible result.

---

# 31. Authentication

Do not store the permanent self-hosting bearer token in localStorage.

Use a simple single-user pairing flow.

Server environment:

```text
ADHD_ADMIN_TOKEN=<long random secret>
```

First connection at home:

```text
enter admin token
      ↓
POST /api/auth/pair
      ↓
server issues long-lived random device session
      ↓
HttpOnly
Secure
SameSite=Strict
cookie
```

The stored database contains only a hash of the device session secret.

When Loro needs to connect:

```text
POST /api/auth/ws-ticket
```

using the HttpOnly cookie.

Server returns a short-lived, one-use or short-expiry sync ticket.

The client passes that temporary ticket using Loro's documented room auth payload mechanism. Loro's official SimpleServer provides an authentication hook for room joins.

Thus:

```text
long-lived credential
→ inaccessible to JavaScript

short-lived WS credential
→ JavaScript memory only
```

---

# 32. Network/security model

Default deployment assumes the sync server is **not Internet exposed**.

Use a stable HTTPS hostname such as:

```text
https://adhd.home.example.com
```

served through Nginx Proxy Manager.

This hostname must remain stable because OPFS, service workers and browser storage are origin-scoped.

Changing:

```text
protocol
hostname
port
```

creates a different browser origin and therefore a different local vault.

Nginx Proxy Manager:

```text
/           → ADHD HTTP :3000
/api/*      → ADHD HTTP :3000
/sync       → ADHD WS   :8787
```

Both listeners can belong to one Node process in one Docker container.

TLS terminates at NPM.

No COOP/COEP headers are needed because the browser no longer depends on SQLite-WASM OPFS.

---

# 33. Server process

One Docker container:

```text
adhd
│
├── HTTP :3000
│   ├── static Next export
│   └── /api/*
│
├── WS :8787
│   └── official Loro server
│
└── /vault
    └── mounted volume
```

Docker:

```text
image
  ├── Next static build
  ├── Node sync server
  └── service worker

volume
  └── /vault
```

No:

```text
Postgres
Redis
MinIO
Elasticsearch
external queue
```

---

# 34. Reconnect algorithm

When ADHD becomes foregrounded:

```text
1. App is already usable from OPFS.

2. Attempt server connection.

3. Obtain temporary WS auth ticket.

4. Connect one Loro WebSocket.

5. Join vault:<vault-id>.

6. Wait until local vault tree has reached server version.

7. GET /api/changes?after=<lastServerSeq>.

8. Build work set:

   local dirty rooms
   UNION
   server changed rooms
   UNION
   new document IDs from merged tree
   UNION
   missing binary IDs

9. Sync Markdown rooms with bounded concurrency.

10. Sync binary files.

11. Wait for server durable versions.

12. Clear dirty entries whose target versions are durable.

13. Advance lastServerSeq.

14. Report "Synced".
```

Use perhaps:

```text
8 simultaneous document rooms
2 simultaneous large binary transfers
```

on mobile.

The exact concurrency is tunable.

---

# 35. Change-log compaction

The server change log does not need infinite retention.

Keep either:

```text
100,000 changes
```

or a generous time period.

Record:

```text
minimum retained server_seq
```

If a client asks:

```text
after=123
```

but the oldest retained sequence is:

```text
500
```

return:

```json
{
  "reset": true
}
```

The client performs full discovery from the tree and asset manifest.

This is slower but safe.

---

# 36. Sync state UI

The app should make local-first semantics visible but unobtrusive.

Possible states:

```text
✓ Saved locally

● Home server unavailable
  4 changes waiting

↻ Syncing
  2 / 4

✓ Synced

⚠ Sync error
```

"Saved" and "Synced" must mean different things.

Editing is never disabled simply because the server is offline.

---

# 37. Graph system

Semantic relationships live in Markdown.

For example:

```yaml
---
status: blocked
deps:
  - "[[Tip Visit]]"
  - "[[Hana Help]]"
---
```

Derived graph:

```text
Markdown
    ↓
frontmatter / links
    ↓
resolve doc IDs
    ↓
React Flow
```

Creating an edge updates the human-readable Markdown relationship.

Visual layout state:

```text
x
y
collapsed
viewport
```

belongs in:

```text
view:<vault-id>:graph
```

not in Markdown.

Mermaid export converts the graph to a Markdown-compatible Mermaid block but does not become the canonical graph representation.

---

# 38. Search and backlink updates

When a Markdown document changes:

```text
Loro commit
     ↓
materialize Markdown
     ↓
parse document
     ├── title
     ├── frontmatter
     ├── headings
     ├── wikilinks
     ├── normal links
     └── tags
     ↓
update derived indexes
```

Do this incrementally.

A complete vault scan is only required when:

```text
first import
cache missing
cache schema changed
repair requested
```

---

# 39. Large file handling

Never load arbitrary large attachments entirely into memory simply to synchronize them.

Stream:

```text
HTTP body
    ↓
hash worker
    ↓
OPFS writable
```

For incremental SHA-256, use a small audited implementation such as `@noble/hashes`; the current v2 package is actively maintained and intentionally small.

Markdown files are small enough to use ordinary in-memory text operations.

---

# 40. Export and disaster recovery

Provide:

```text
Settings → Export Vault
```

which creates a normal ZIP.

`fflate` is appropriate because it supports browser ZIP creation and streaming.

Two export modes:

```text
Portable Vault

Notes/
Attachments/
Projects/
...
```

and:

```text
Full ADHD Backup

normal vault
+
.adhd/
```

Portable restore:

```text
scan filesystem
assign/recover IDs
create fresh Loro state
rebuild indexes
```

Full restore retains CRDT history.

---

# 41. Unsynced iPhone safety

Persistent OPFS greatly reduces storage-eviction risk, but browser-local storage should never be described as equivalent to an independent server backup.

If the phone contains unsynced changes:

```text
7 local changes not yet backed up
```

show that state clearly.

Offer:

```text
Export unsynced backup
```

so the user can manually save a ZIP while away from home if desired.

Once the home server confirms durable synchronization:

```text
0 unbacked changes
```

---

# 42. Service startup/recovery

Server startup:

```text
1. Open/validate SQLite.

2. Load vault tree CRDT.

3. Load known document snapshots.

4. Validate snapshot checksums.

5. Scan physical vault.

6. Compare filesystem with materialized checkpoints.

7. Import genuine external filesystem differences.

8. Repair missing/stale materializations.

9. Rebuild SQLite if required.

10. Start watcher.

11. Accept sync clients.
```

Client startup:

```text
1. Load static shell.

2. Acquire vault Web Lock.

3. Open OPFS.

4. Load vault-tree CRDT.

5. Validate CRDT snapshots/update segments.

6. Repair stale Markdown materializations if needed.

7. Restore search index or rebuild.

8. Display local vault.

9. Attempt server connection asynchronously.
```

The UI does not wait for step 9.

---

# 43. External mass-change reconciliation

For operations such as:

```bash
git checkout another-branch
git pull
rsync
bulk rename
```

do not process every watcher event independently.

Watcher:

```text
events
   ↓
250ms debounce
   ↓
scan affected directories
   ↓
identify docs by embedded IDs
   ↓
produce structural/text changes
   ↓
apply as one reconciliation batch
```

This produces dramatically more understandable history and fewer transient conflicts.

---

# 44. App updates

The service worker controls shell versioning.

When a new app version is available at home:

```text
new SW downloaded
      ↓
"Update available"
      ↓
ensure local writes flushed
      ↓
activate new SW
      ↓
reload
```

Never force an update in the middle of an unsaved local write.

Vault storage schemas have explicit versions and migrations.

Derived caches can simply be discarded during incompatible upgrades.

CRDT/file formats should migrate only when necessary.

---

# 45. Implementation phases

## P0 - Architecture validation

Before UI development, prove these cases in automated tests:

```text
offline phone edit + desktop edit → merge

phone edit + external VS Code edit → merge

external rename + phone text edit → rename preserved, text preserved

concurrent moves to different folders

concurrent same-name file creation

server crash after WebSocket ACK but before snapshot persistence

browser crash after Loro update but before Markdown materialisation

duplicate note caused by cp

binary conflict

reconnect after server change-log compaction
```

Also validate on a real iPhone, not only Safari desktop.

This phase is a gate.

## P1 - Vault engine

Implement:

```text
native OPFS VaultFS
Loro persistence
vault LoroTree
document IDs
Markdown materialisation
Web Locks
search indexing
```

No network required.

## P2 - Editor

Implement:

```text
CodeMirror
loro-codemirror
Markdown highlighting
frontmatter
preview
wikilinks
backlinks
tags
```

## P3 - PWA/iPhone

Implement:

```text
static export
service worker
offline shell
storage persistence
full-vault offline provisioning
install UX
quota/status UI
```

Test on physical iPhone.

## P4 - Sync server

Implement:

```text
official Loro WS
persistence hooks
SQLite discovery log
durable-version confirmation
asset sync
auth/pairing
Docker image
NPM routing
```

## P5 - External filesystem bridge

Implement:

```text
Chokidar
three-way branch import
rename detection
copy-ID detection
mass-change batching
Git checkout testing
```

## P6 - Graph/UI polish

Implement:

```text
React Flow
dependencies
graph view CRDT
Mermaid export
mobile UI
search UX
trash/history UI
```

---

# 46. Things explicitly not used

Do not use these as foundations:

```text
PowerSync
RxDB
Dexie Cloud
Postgres
MinIO
browser SQLite
ZenFS
service-worker cache for vault data
pathnames as identity
mtime as synchronization identity
one giant Loro document
one WebSocket per note
last-write-wins for binary conflicts
Internet connectivity as a prerequisite to edit
```

None is inherently bad; they simply do not improve this particular architecture.

---

# 47. Architectural invariants

These should be encoded into tests.

### A

If `.adhd/cache/` disappears:

> no user data is lost.

### B

If server SQLite disappears:

> no user content is lost.

### C

If all Loro data disappears but Markdown/files remain:

> current user content is recoverable, although CRDT history is lost.

### D

If the home server is offline:

> the entire application remains usable.

### E

If two devices make compatible Markdown edits offline:

> both edits survive reconciliation.

### F

If a binary asset changes concurrently:

> both versions survive.

### G

If a note is renamed on one device and edited on another:

> the result is one renamed note containing the merged edits.

### H

If the browser reports "Synced":

> the home server has durably persisted a version containing those local operations.

### I

No ordinary user content depends on:

> Postgres, IndexedDB schema, SQLite schema or an ADHD-specific binary format.

### J

At a clean materialization checkpoint:

```text
SHA256(LoroText)
==
SHA256(markdown file)
```

---

# 48. Final architecture

```text
                         ADHD
                   Next.js PWA shell
                          │
             ┌────────────┴────────────┐
             │                         │
         CodeMirror                 Vault UI
             │                         │
      loro-codemirror               LoroTree
             │                         │
          LoroText                     │
             └───────────┬─────────────┘
                         │
                   local commit
                         │
              ┌──────────┴──────────┐
              │                     │
          CRDT state             Markdown
              │                     │
              └──────── OPFS ───────┘
                         │
                 complete offline
                     replica
                         │
                  server reachable
                         │
                         ▼
              official Loro protocol
                   one WebSocket
                         │
          ┌──────────────┴─────────────┐
          │                            │
     CRDT document sync            HTTP assets
          │                            │
          └──────────────┬─────────────┘
                         ▼
                   HOME SERVER
                         │
          ┌──────────────┼───────────────┐
          │              │               │
       Loro rooms      SQLite         Chokidar
          │         discovery only        │
          │              │            external
          └──────────────┼──────────── filesystem
                         │
                         ▼
                     /vault/
                         │
               NORMAL HUMAN FILES
                         │
           ┌─────────────┼─────────────┐
           │             │             │
         *.md         folders       attachments
```

This is the architecture to implement unless one of the P0 real-device/failure tests demonstrates a concrete flaw.

