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
- Light, dark and system themes
- Installable PWA with storage-persistence and quota status
- Note identity kept outside the files (vault tree + `.adhd/index.json`), so renames and moves keep history

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
| `npm run build` | Next standalone server build (`.next/standalone`) and service-worker build |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint |
| `npm run build:server` | Bundle the sync server (`dist/server.cjs`) |
| `npm run start:server` | Run the bundled sync server |

## Self-hosting with Docker

The sync server ships as a single container serving the static app, the HTTP API, and
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
and editable with any normal tool — `.adhd/` inside it holds sync metadata (CRDT history,
discovery index), not required to read your notes.

**Updating:**

```bash
docker compose pull && docker compose up -d
```

**Backup:** back up the whole `./vault` directory, including `.adhd/` — that's what lets
devices resume sync without a full resend.

### Connecting to a sync server

Once a server is running (above), point each browser at it:

1. Open the app **from the server's own URL** (e.g. `http://localhost:8080`, or your
   `https://adhd.home.example.com` if you're behind a reverse proxy) — this is required:
   OPFS/service-worker storage is scoped per origin, so a vault opened from a different
   origin is a different, unsynced vault.
2. Open **Sync settings** — from the status popover in the sidebar footer, or <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd> → "Sync settings".
3. Paste the server URL (auto-filled with the current origin when it's detected as a
   Methyl server) and the `METHYL_AUTH_TOKEN` you set above. "Test connection" checks
   both before you save.
4. Save. Only the tab holding the vault's writer lock (SPEC §12) opens a sync
   connection; other tabs stay read-only and don't duplicate it.

The server URL and access token are saved in this browser's `localStorage` — not a
cookie — so treat them like any other locally-stored secret: anyone with access to this
browser profile/device can read the token. This is fine for the intended deployment (a
LAN-only server, see [Network/security model](SPEC.md) in SPEC.md §32) but is a real
tradeoff versus a proper pairing flow.

If the app and the sync server are served from **different origins** (not the default
above), set `METHYL_ALLOWED_ORIGINS` on the server to a comma-separated list of allowed
app origins so its `/api/*` and `/healthz` responses carry the right CORS headers — by
default, cross-origin requests are rejected by the browser.

## Vault layout

```text
vault/
├── Projects/
│   └── welcome.md        # plain Markdown, usable anywhere
├── Attachments/
└── .adhd/                # app metadata — sync history and identity, not needed to read notes
    ├── crdt/             # Loro snapshots and updates per document
    └── index.json        # path → document id + content hash
```

Internal names (`.adhd/`, `adhd-vault`) predate the Methyl name and are kept for compatibility with existing vaults.

## Tech stack

Next.js 16 (standalone server) · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui (Base UI) · CodeMirror 6 · Loro CRDT · OPFS · Web Locks · Serwist · dnd-kit · Vitest

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

[SPEC.md](SPEC.md) is the architecture specification: data model, identity, persistence, crash-safe writes, sync topology and service-worker design.

## License

[MIT](LICENSE)
