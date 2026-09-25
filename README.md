# Methyl

A self-hostable, offline-first Markdown vault. Obsidian-style notes in your browser, on your phone and on your own server — with plain folders and `.md` files as the only data format that matters.

> **Status:** early development. The browser app works offline against a local vault, and can now connect to a self-hosted sync server (see [Connecting to a sync server](#connecting-to-a-sync-server)) so notes sync across devices.

## Principles

- **Your files stay yours.** Notes are ordinary Markdown in ordinary folders. No IDs, markers or app metadata inside `.md` files — open them in VS Code, Git or any other editor.
- **Offline first.** The whole vault lives on the device (OPFS in the browser) and the app shell is cached by a service worker. No network required to read or write.
- **Merge, don't lose.** Each note is a [Loro](https://loro.dev) CRDT, so edits made on several disconnected devices reconcile automatically.
- **No infrastructure.** Target deployment is one container plus one mounted vault folder — no Postgres, Redis or object storage.

Markdown is the portable truth, Loro is the sync/history format, everything else is disposable derived state.

## Features

- CodeMirror 6 Markdown editor with live CRDT binding
- Folder tree sidebar with drag-and-drop moves and manual ordering
- Command palette (<kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd>) for notes and actions
- Rename / delete for notes and folders; titles come from file names
- Import Obsidian vaults with folders, Markdown notes, and attachments preserved
- 7 themes (Light, Dark, Obsidian, Obsidian Light, Nord, Catppuccin Mocha, Rosé Pine Dawn) plus System
- Installable PWA with storage-persistence and quota status
- Note identity kept outside the files (vault tree + `.methyl/index.json`), so renames and moves keep history
- A small plugin system (see [Plugins](#plugins))

## Getting started

Requires Node.js 24 LTS.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. A fresh vault is created in the browser's private file system with a welcome note.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next dev server plus service-worker build in watch mode |
| `npm run build` | Next build and service-worker build |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:e2e` | Playwright end-to-end tests (real Chromium; builds and serves the app first) |
| `npm run test:e2e:ui` | Playwright's interactive UI runner |
| `npm run lint` | ESLint |
| `npm run build:server` | Bundle the sync server (`dist/server.cjs`) |
| `npm run start:server` | Run the bundled sync server |

## Self-hosting with Docker

The sync server ships as a single container serving the app (Next.js in-process), the HTTP API, and
the sync WebSocket all on one port.

```bash
cp .env.example .env
# put a random secret in .env, e.g.:
openssl rand -hex 32
```

```yaml
# docker-compose.yml
services:
  methyl:
    image: ghcr.io/doomedramen/methyl:latest
    ports:
      - "8080:8080"
    volumes:
      - ./vault:/vault
    environment:
      METHYL_AUTH_TOKEN: ${METHYL_AUTH_TOKEN:?set METHYL_AUTH_TOKEN}
    restart: unless-stopped
```

```bash
docker compose up -d
```

Open <http://localhost:8080>. Notes live in `./vault` as plain Markdown files, readable
and editable with any normal tool — `.methyl/` inside it holds sync metadata (CRDT history,
discovery index), not required to read your notes.

**Serve it over https.** Browsers only give a page persistent storage (OPFS, where
Methyl keeps your vault) in a secure context: `https://`, or `http://localhost` on the
machine itself. Reached over plain http from a LAN address (`http://192.168.1.10:8080`)
the app can't store anything and says so on launch. Put it behind a reverse proxy with a
certificate (Caddy, Traefik, nginx) or expose it through Tailscale.

**Updating:**

```bash
docker compose pull && docker compose up -d
```

**Backup:** the server can back itself up while it runs. The backup is a folder holding the
whole vault — notes, attachments and the `.methyl/` metadata that lets devices resume sync
without a full resend — with the sync database copied through SQLite's online backup, so
it's consistent mid-write:

```bash
docker compose exec methyl node dist/server.cjs backup /vault-backups/$(date +%F)
```

(mount a `/vault-backups` volume for that, or back up to any path in the container and copy
it out). A nightly cron entry running the same command is enough for most setups.

**Restore:** stop the server, move the damaged vault folder aside, then restore into the
now-empty folder and start the server again:

```bash
docker compose run --rm methyl node dist/server.cjs restore /vault-backups/2026-09-24
docker compose up -d
```

Restore refuses to write into a vault folder that isn't empty. With `METHYL_VAULTS_PATH`
(below), name the vault: `backup --vault work /vault-backups/work-$(date +%F)`.

In the browser, **Export vault** (Markdown and attachments, opens anywhere) and **Export full
backup** (adds the `.methyl/` metadata) are in the command menu (<kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd>).

### Connecting to a sync server

Once a server is running (above), point each browser at it:

1. Open the app **from the server's own URL** (e.g. `http://localhost:8080`, or your
   `https://methyl.home.example.com` if you're behind a reverse proxy) — this is required:
   OPFS/service-worker storage is scoped per origin, so a vault opened from a different
   origin is a different, unsynced vault.
2. Open **Sync settings** — from the status popover in the sidebar footer, or <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd> → "Sync settings".
3. Check the server URL (it starts as the current origin), paste the `METHYL_AUTH_TOKEN`
   you set above as the **Admin token**, and pick the **Server vault** this browser
   vault syncs with (a server with one vault calls it `default`).
4. **Pair and save.** The token is used once, to pair this browser, and isn't kept. The
   server signs the browser in with an HttpOnly cookie, and each sync connection uses a
   ticket that's valid for a minute. Only the tab holding the vault's writer lock (SPEC §12)
   opens a sync connection; other tabs stay read-only and don't duplicate it.

The browser vault and the server's mounted folder are separate local copies.
After connecting Sync, copying a `.md` file or creating a folder in the mounted
folder is detected by the server and appears in the browser automatically;
empty folders are supported too. Without Sync configured, use **Import Obsidian
vault** in the app instead — changing the server's folder cannot change an
offline browser vault.

**Paired devices** are listed in Sync settings. **Unpair** signs this browser out; with the
admin token entered, **Remove** signs out any other device at once, including its open
sync connections. A browser that saved the token with an older version pairs with it on
first start and deletes it.

Browser sync needs the app and the server on the **same site** (the pairing cookie is
`SameSite=Strict`), which the default above already is. `METHYL_ALLOWED_ORIGINS` (a
comma-separated list of origins) adds CORS headers to `/api/*` and `/healthz`, for scripts
on another origin that use the admin token.

### Server settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `METHYL_AUTH_TOKEN` | *(required)* | The admin token: pairs browsers, and authenticates scripts (`Authorization: Bearer …`). |
| `METHYL_PORT` / `METHYL_HOST` | `8080` / `0.0.0.0` | Where the server listens. |
| `METHYL_VAULT_PATH` | `/vault` | The mounted vault folder, served as the vault `default`. Ignored when `METHYL_VAULTS_PATH` is set. |
| `METHYL_VAULTS_PATH` | *(unset)* | A folder of vaults: each sub-folder is served as its own vault. See [Vaults](#vaults). |
| `METHYL_WATCH` | `true` | Watch the vault folder for external edits. |
| `METHYL_ALLOWED_ORIGINS` | *(empty)* | CORS allow-list, see above. |
| `METHYL_TRUST_PROXY` | `false` | Set to `true` only behind a reverse proxy you control. Failed logins are then counted per `X-Forwarded-For` address instead of per proxy. |
| `METHYL_MAX_ASSET_BYTES` | `536870912` (512 MiB) | Largest attachment upload accepted. |

Ten failed authentication attempts from one address within a minute lock that
address out (HTTP `429`); each further lockout doubles, up to 15 minutes.

## Vaults

The browser can hold several vaults — separate sets of notes, each with its own sync
settings. The vault name at the top of the sidebar switches between them; **Manage vaults…**
(also in the command menu) creates, renames and deletes vaults, and imports a full backup
(**Export full backup**) as a new vault. A vault's notes live at `/<vault id>/<note path>`
in the app's URLs.

The server can serve several vaults too. Mount a folder of vaults and set
`METHYL_VAULTS_PATH` to it; each sub-folder named with lower-case letters, digits and
hyphens (e.g. `personal`, `work`) is a vault, with its own sync database, change feed and
file watcher. Folders added or removed while the server runs are picked up within a
second or so. In each browser vault's sync settings, choose the **Server vault** to sync
with.

To move an existing single-vault server over, stop it, move the vault folder into the
vaults folder under a name (say `/vaults/personal`), set `METHYL_VAULTS_PATH=/vaults`, and
start it again. The server never moves your folders itself. Browsers keep syncing with
the vault called `default`, so either name that folder `default` or change each
browser's **Server vault** setting to the new name.

Server API, per vault: `/api/v/<vault>/…` and the sync socket at `/sync/<vault>`;
`GET /api/vaults` lists them. The old unprefixed `/api/…` routes still reach the
`default` vault but are deprecated.

## Plugins

Methyl has a small, Obsidian-inspired plugin system. A plugin registers editor
extensions, commands (with optional hotkeys) and completion sources against an
`App` facade — it never touches app internals directly. Five are bundled and
enabled by default: Core Commands, Core Live Preview, Core Templates, Core
Wikilinks, and Word Count (adds a "Word count: Show" command, default hotkey
<kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>W</kbd>).

Core Templates lets you define reusable Markdown and choose **From template**
from any new-note menu. Template definitions are stored in the plugin's vault
data file.

- **Plugins: Manage** (via <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd>, or the
  puzzle-piece icon) opens a dialog listing every bundled plugin with an
  enable/disable toggle and any load error.
- Enabled state persists to `.methyl/plugins.json`; a plugin's own data
  (settings it saves via `saveData`/`loadData`) lives at
  `.methyl/plugins/<id>/data.json`.
- Hotkeys can be remapped by hand-editing `.methyl/hotkeys.json` — a map of
  `"pluginId:commandId"` to an array of `{ modifiers, key }` bindings — which
  overrides that command's default binding.

See [the plugin system design spec](docs/superpowers/specs/2026-09-18-plugin-system-design.md)
for the full API surface and rationale.

## Vault layout

```text
vault/
├── Projects/
│   └── welcome.md        # plain Markdown, usable anywhere
├── Attachments/
└── .methyl/                # app metadata — sync history and identity, not needed to read notes
    ├── crdt/             # Loro snapshots and updates per document
    ├── index.json        # path → document id + content hash
    ├── plugins.json      # which bundled plugins are enabled
    ├── plugins/<id>/data.json  # per-plugin settings
    └── hotkeys.json      # optional hotkey overrides, keyed "pluginId:commandId"
```

Vaults created before the rename kept their metadata in `.adhd/`; it is moved to `.methyl/` automatically the first time a newer version opens the vault (the server renames it; the browser copies, verifies, then removes the old copy).

## Tech stack

Next.js 16 (in-process server) · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui (Base UI) · CodeMirror 6 · Loro CRDT · OPFS · Web Locks · Serwist · dnd-kit · Vitest

## Project structure

```text
src/
├── app/                 # Next app router, layout, service worker entry
├── components/
│   ├── ui/              # shadcn/ui components
│   ├── vault/           # app shell, sidebar tree, command menu, note actions
│   ├── editor/          # CodeMirror host
│   └── pwa/             # install / storage status
└── lib/
    ├── core/            # documents, Markdown parsing, identity index, paths
    ├── vault/           # vault engine, tree CRDT, OPFS / memory stores
    ├── browser/         # browser vault bootstrap, PWA hooks, sync host
    ├── sync/            # sync coordinator and journal
    ├── server/          # Node file store and sync server
    └── editor/          # CodeMirror extensions and theme
```

## Documentation

[TODO.md](TODO.md) tracks known bugs, gaps and polish that the spec doesn't cover.
[SPEC.md](SPEC.md) is the architecture specification: data model, identity, persistence, crash-safe writes, sync topology and service-worker design.

## License

[MIT](LICENSE)
