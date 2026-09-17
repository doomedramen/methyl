# Methyl

A self-hostable, offline-first Markdown vault. Obsidian-style notes in your browser, on your phone and on your own server — with plain folders and `.md` files as the only data format that matters.

> **Status:** early development. The browser app works offline against a local vault. The sync server and Docker deployment described in [SPEC.md](SPEC.md) are in progress and not yet runnable as a standalone service.

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
| `npm run build` | Static export (`out/`) and service-worker build |
| `npm run serve:static` | Serve the static export locally |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint |

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

Next.js 16 (static export) · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui (Base UI) · CodeMirror 6 · Loro CRDT · OPFS · Web Locks · Serwist · dnd-kit · Vitest

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
