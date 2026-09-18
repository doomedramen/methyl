"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TreeID } from "loro-crdt";
import { Check, Inbox, Plus, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { VaultTree, VaultTreeNode } from "@/lib/vault/tree";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { NoteEditor } from "@/components/editor/NoteEditor";
import { detectGraphDocument, emptyGraphMarkdown } from "@/lib/graph/detect";
import { AppSidebar, type FolderRow, type NoteRow, type SidebarRow } from "./AppSidebar";
import { ModeToggle } from "@/components/mode-toggle";
import type { VaultEngine } from "@/lib/vault/engine";
import { SyncProvider } from "@/lib/browser/sync-context";
import type { docIdForPath, notePathFromLocation, pathForDocId } from "@/lib/vault/note-path";
import { VaultAccessBanner } from "./VaultAccessBanner";
import { captureToInbox, INBOX_FOLDER_NAME } from "@/lib/vault/inbox";
import { setAppBadge } from "@/lib/browser/pwa";
import { shareToCaptures, type SharePayload } from "@/lib/vault/share-payload";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { vaultPluginStorage } from "@/lib/plugins/vault-storage";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { PluginHostProvider } from "@/lib/plugins/react";
import type { App, NoteContext } from "@/lib/plugins/api";
import { useSidebar } from "@/components/ui/sidebar";
import { useSync } from "@/lib/browser/sync-context";
import { useTheme } from "next-themes";
import { Laptop, Puzzle } from "lucide-react";
import { APP_THEMES } from "@/lib/themes";
import { BUNDLED_PLUGINS } from "@/plugins";
import type { resolveWikilink, listWikilinkCandidates } from "@/lib/vault/wikilink";
import { PluginsDialog } from "@/components/plugins/PluginsDialog";

/**
 * File System Access API's launch-on-open surface. Not in lib.dom yet, so
 * it's typed narrowly here rather than widening `Window` app-wide — see
 * the file_handlers entry in manifest.webmanifest, which is what makes the
 * OS hand Methyl a `?action=open-file` launch with files attached.
 */
interface LaunchParams {
  readonly files: FileSystemFileHandle[];
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void;
}
declare global {
  interface Window {
    launchQueue?: LaunchQueue;
  }
}

/**
 * The graph editor (ReactFlow ~100KB+) and the command palette (cmdk) are
 * on-demand features, so they're split out of the initial route bundle and
 * fetched only when a graph document opens / Cmd+K is pressed. Both are
 * client-only and rendered only once the engine is ready, so skipping SSR
 * costs nothing (the pre-boot shell already renders the loading skeleton).
 */
const GraphEditor = dynamic(
  () => import("@/components/graph/GraphEditor").then((mod) => mod.GraphEditor),
  { ssr: false, loading: () => <GraphLoading /> },
);
const CommandMenu = dynamic(
  () => import("./CommandMenu").then((mod) => mod.CommandMenu),
  { ssr: false },
);

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const SAVE_LABEL: Record<Exclude<SaveState, "idle">, string> = {
  dirty: "Editing…",
  saving: "Saving…",
  saved: "Saved",
  error: "Not saved",
};

/** How long the "Saved" confirmation lingers before hiding. */
const SAVED_VISIBLE_MS = 2000;

/**
 * Build the nested folder/note tree for the sidebar, in stored tree order.
 * The displayed title is always the tree node's file name (minus `.md`) —
 * never frontmatter `title:` or an `# H1` in the body. Those can be edited
 * or deleted freely without the note vanishing or being relabeled out from
 * under the user; only a rename (which renames the file) changes the title.
 */
function toRow(node: VaultTreeNode, tree: VaultTree, engine: VaultEngine): SidebarRow {
  if (node.kind === "directory") {
    return {
      treeId: node.treeId,
      kind: "directory",
      name: node.name,
      children: tree.children(node.treeId).map((child) => toRow(child, tree, engine)),
    };
  }
  const doc = node.documentId ? engine.getDocument(node.documentId) : undefined;
  const isGraph = doc ? detectGraphDocument(doc.getMarkdown()) !== null : false;
  return {
    treeId: node.treeId,
    kind: "markdown",
    id: node.documentId ?? node.treeId,
    title: node.name.replace(/\.md$/i, ""),
    isGraph,
  };
}

function buildRootRows(tree: VaultTree, engine: VaultEngine): SidebarRow[] {
  return tree.roots().map((node) => toRow(node, tree, engine));
}

function flattenNotes(rows: SidebarRow[]): NoteRow[] {
  const out: NoteRow[] = [];
  for (const row of rows) {
    if (row.kind === "markdown") out.push(row);
    else out.push(...flattenNotes(row.children));
  }
  return out;
}

function findFolder(rows: SidebarRow[], treeId: TreeID): FolderRow | undefined {
  for (const row of rows) {
    if (row.kind === "directory") {
      if (row.treeId === treeId) return row;
      const found = findFolder(row.children, treeId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Builds the plugin `App` facade and owns the `PluginHost`/`CommandRegistry`
 * for the mounted vault. Rendered inside `SyncProvider`/`SidebarProvider` (not
 * `VaultApp` itself) because `useSidebar`/`useSync` are only valid inside
 * those providers.
 */
function VaultPluginBridge({
  engine,
  onCreateNote,
  onCreateGraph,
  onCreateFolder,
  onManagePlugins,
  activeNote,
  onOpenNote,
  onNotesChanged,
  readOnly,
  children,
}: {
  engine: VaultEngine | null;
  onCreateNote: () => Promise<string> | void;
  onCreateGraph: () => Promise<string> | void;
  onCreateFolder: () => void;
  /** Opens `PluginsDialog` (Task 11); a no-op until that dialog exists. */
  onManagePlugins?: () => void;
  /** The single open note (this app shows one editor pane at a time). */
  activeNote: NoteContext | null;
  onOpenNote: (id: string) => void;
  onNotesChanged: () => void;
  /** This tab doesn't hold the writer lock (§12) — block wikilink note creation. */
  readOnly: boolean;
  children: ReactNode;
}) {
  const { toggleSidebar } = useSidebar();
  const { setDialogOpen: setSyncDialogOpen } = useSync();
  const { setTheme } = useTheme();

  const commandRegistry = useMemo(() => new CommandRegistry(), []);
  const fallbackHost = useMemo(() => new PluginHost(makeNoopApp(), new InMemoryPluginStorage()), []);
  const [host, setHost] = useState<PluginHost | null>(null);

  // `@/lib/vault/wikilink` value-imports `@/lib/vault/engine`, which
  // value-imports `loro-crdt` (WASM) — statically importing it here would
  // pull loro-crdt into the SSR module graph via src/app/page.tsx -> VaultApp
  // and crash the server render (ENOENT on the wasm binary, since the SSR
  // bundle doesn't ship/resolve it the way the client chunk does). Load it
  // dynamically, same as NoteEditor.tsx already does for the same reason.
  const wikilinkModRef = useRef<{
    resolveWikilink: typeof resolveWikilink;
    listWikilinkCandidates: typeof listWikilinkCandidates;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("@/lib/vault/wikilink").then((mod) => {
      if (!cancelled) wikilinkModRef.current = mod;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const notify = useCallback((msg: string, kind?: "info" | "success" | "error") => {
    if (kind === "error") toast.error(msg);
    else if (kind === "success") toast.success(msg);
    else toast(msg);
  }, []);

  const app: App = useMemo<App>(
    () => ({
      commands: {
        list: () => commandRegistry.list(null),
        execute: (fullId) => {
          void commandRegistry.execute(fullId, null, null, notify);
        },
      },
      workspace: {
        getActiveNote: (): NoteContext | null => activeNote,
        openNote: (id: string) => onOpenNote(id),
        toggleSidebar: () => toggleSidebar(),
        openDialog: (name: string) => {
          if (name === "sync") {
            setSyncDialogOpen(true);
            return;
          }
          if (name === "plugins") {
            onManagePlugins?.();
            return;
          }
        },
        resolveWikilink: (target: string) =>
          engine && wikilinkModRef.current
            ? wikilinkModRef.current.resolveWikilink(engine.tree, target, activeNote?.documentId ?? "")
            : undefined,
        getWikilinkCandidates: () =>
          engine && wikilinkModRef.current ? wikilinkModRef.current.listWikilinkCandidates(engine.tree) : [],
        createWikilinkTarget: (target: string) => {
          if (!engine || !wikilinkModRef.current) return;
          if (readOnly) {
            toast.error("This vault is open for editing in another tab.");
            return;
          }
          const parentTreeId = (() => {
            if (!activeNote) return undefined;
            const node = engine.tree.findByDocumentId(activeNote.documentId);
            if (!node) return undefined;
            return engine.tree.tree.getNodeByID(node.treeId)?.parent()?.id;
          })();
          const name = target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
          const created = engine.createDocument(parentTreeId, name, "");
          void engine.persistTreeIncremental();
          void engine.persistDocumentIncremental(created.id);
          onNotesChanged();
          toast.success(`Created "${target}"`);
          onOpenNote(created.id);
        },
      },
      vault: {
        createNote: async () => {
          await onCreateNote();
          return "";
        },
        createGraph: async () => {
          await onCreateGraph();
          return "";
        },
        createFolder: async () => {
          onCreateFolder();
        },
        read: async () => null,
        list: () => [],
      },
      notify,
    }),
    [
      activeNote,
      commandRegistry,
      engine,
      notify,
      onCreateFolder,
      onCreateGraph,
      onCreateNote,
      onManagePlugins,
      onNotesChanged,
      onOpenNote,
      readOnly,
      setSyncDialogOpen,
      toggleSidebar,
    ],
  );

  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    const newHost = new PluginHost(app, vaultPluginStorage(engine), commandRegistry);
    for (const [manifest, PluginClass] of BUNDLED_PLUGINS) newHost.register(manifest, PluginClass);
    void newHost.enableFromStorage().then(() => {
      if (!cancelled) setHost(newHost);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // Theme switching and "Plugins: Manage" need `next-themes`/dialog state
  // that `src/plugins/**` may not import (ESLint restriction, Task 12), so
  // they're registered here directly against the shared registry under the
  // `core-commands` plugin id rather than inside `CoreCommandsPlugin`.
  useEffect(() => {
    const disposers = [
      commandRegistry.add("core-commands", {
        id: "manage-plugins",
        name: "Plugins: Manage",
        icon: Puzzle,
        callback: () => onManagePlugins?.(),
      }),
      ...APP_THEMES.map(({ id, label, icon }) =>
        commandRegistry.add("core-commands", {
          id: `theme-${id}`,
          name: `Theme: ${label}`,
          icon,
          callback: () => setTheme(id),
        }),
      ),
      commandRegistry.add("core-commands", {
        id: "theme-system",
        name: "Theme: System",
        icon: Laptop,
        callback: () => setTheme("system"),
      }),
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, [commandRegistry, onManagePlugins, setTheme]);

  return (
    <PluginHostProvider host={host ?? fallbackHost} commands={commandRegistry} app={app} activeNote={null}>
      {children}
    </PluginHostProvider>
  );
}

function makeNoopApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: { getActiveNote: () => null, openNote: () => {}, toggleSidebar: () => {}, openDialog: () => {} },
    vault: {
      createNote: async () => "",
      createGraph: async () => "",
      createFolder: async () => {},
      read: async () => null,
      list: () => [],
    },
    notify: () => {},
  };
}

export function VaultApp() {
  const [engine, setEngine] = useState<VaultEngine | null>(null);
  const [rows, setRows] = useState<SidebarRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [pluginsDialogOpen, setPluginsDialogOpen] = useState(false);
  // Incremented each time the user asks to save (Cmd/Ctrl+S); the active
  // editor watches it and flushes immediately.
  const [saveRequest, setSaveRequest] = useState(0);

  const refreshNotes = useCallback((eng: VaultEngine) => {
    setRows(buildRootRows(eng.tree, eng));
  }, []);

  // The open note lives in the URL as `/<vaultId>/<vault path>` (e.g.
  // /local/Projects/note.md) so a refresh reopens it. The URL mirrors
  // `activeId`; it is never the source of truth, and it is rewritten in
  // place (no history entries). Unknown paths fall back to the app shell:
  // src/app/[...slug]/page.tsx in dev, index.html from the server's static
  // handler in production.
  const urlRestored = useRef(false);
  // Populated once the dynamic import below resolves; the URL-mirroring
  // effect only runs once `urlRestored` is set, so it's always available by
  // then.
  const notePathRef = useRef<typeof import("@/lib/vault/note-path") | null>(null);

  const notes = useMemo(() => flattenNotes(rows), [rows]);

  // OS icon badge mirrors how many notes are waiting in Inbox/ — the one
  // place captures land unread — rather than the whole vault's note count,
  // which would just be background noise. Direct children only: a note
  // filed deeper by the user has already been "read" out of the inbox.
  useEffect(() => {
    const inbox = rows.find((r): r is FolderRow => r.kind === "directory" && r.name === INBOX_FOLDER_NAME);
    const count = inbox ? inbox.children.filter((c) => c.kind === "markdown").length : 0;
    void setAppBadge(count);
  }, [rows]);

  useEffect(() => {
    let cancelled = false;
    // Dynamic import keeps loro-crdt WASM out of the prerender module graph
    // (note-path.ts pulls it in transitively via vault/engine.ts).
    Promise.all([
      import("@/lib/browser/vault"),
      import("@/lib/vault/engine"),
      import("@/lib/vault/note-path"),
    ])
      .then(async ([{ getVault }, , notePath]) => {
        const eng = await getVault();
        if (cancelled) return;
        notePathRef.current = notePath;
        setEngine(eng);
        refreshNotes(eng);

        const wanted = notePath.notePathFromLocation(window.location.pathname, eng.vaultId);
        if (wanted) {
          const found = notePath.docIdForPath(eng.tree, wanted);
          if (found) setActiveId(found);
        }
        urlRestored.current = true;
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNotes]);

  // Re-render when this tab is promoted to writer in place (§12) — the
  // engine object reference doesn't change (see becomeWriter in
  // browser/vault.ts), only its `releaseWriterLock` field, so `readOnly`
  // below and requireWriter() need this tick to pick that up without a
  // reload.
  const [, forceAccessTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    import("@/lib/browser/vault").then(({ onVaultAccessStatusChange }) => {
      if (cancelled) return;
      cleanup = onVaultAccessStatusChange(() => forceAccessTick((t) => t + 1));
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  // Mirror the open note into the URL once the initial restore has run, so
  // a stale or missing `?note=` is cleared instead of reopened forever.
  useEffect(() => {
    if (!engine || !urlRestored.current || !notePathRef.current) return;
    const path = activeId ? notePathRef.current.pathForDocId(engine.tree, activeId) : null;
    const next = path
      ? `/${encodeURIComponent(engine.vaultId)}/${path.split("/").map(encodeURIComponent).join("/")}`
      : "/";
    if (next !== window.location.pathname) {
      window.history.replaceState(null, "", next + window.location.search + window.location.hash);
    }
  }, [engine, activeId, rows]);

  const saveErrorShown = useRef(false);
  const onSaveError = useCallback(() => {
    if (!saveErrorShown.current) {
      saveErrorShown.current = true;
      toast.error("Changes to this note weren't saved. Copy your text before reloading.");
    }
    setSaving("error");
  }, []);

  // Only confirm a save that followed an edit; persists on open stay silent.
  const onPersisted = useCallback(() => {
    setSaving((prev) => (prev === "idle" ? prev : "saved"));
  }, []);

  // Cmd/Ctrl+S: trigger a save in the open editor and surface the "Saved"
  // badge — both when there's something to flush and as a confirmation that
  // the doc is already persisted. A stale writer-lock flag is avoided by
  // reading `isWriter` below, which re-derives on the §12 promotion tick.
  const isWriter = Boolean(engine?.releaseWriterLock);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!engine || !activeId || !isWriter) return;
        setSaveRequest((n) => n + 1);
        // Show the confirmation immediately; a failing persist overwrites
        // it with the error state.
        setSaving((prev) => (prev === "error" ? prev : "saved"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [engine, activeId, isWriter]);

  useEffect(() => {
    if (saving !== "saved") return;
    const t = setTimeout(() => setSaving("idle"), SAVED_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [saving]);

  useEffect(() => {
    setSaving("idle");
    saveErrorShown.current = false;
  }, [activeId]);

  // Blocks mutations from a read-only tab (§12) — this engine is a real,
  // writable-in-memory VaultEngine.open() result even when this tab
  // doesn't hold the writer lock, so nothing else stops these calls from
  // reaching OPFS concurrently with whichever tab *does* hold the lock.
  const requireWriter = useCallback(() => {
    if (engine && !engine.releaseWriterLock) {
      toast.error("This vault is open for editing in another tab. Use \"Use here\" to take over.");
      return false;
    }
    return true;
  }, [engine]);

  const onCreateNote = useCallback(
    (parentTreeId?: TreeID) => {
      if (!engine || !requireWriter()) return;
      // Tree auto-suffixes on a name clash within the folder (Untitled.md
      // -> Untitled 2.md -> ...), so it's always safe to ask for the same
      // base name.
      const doc = engine.createDocument(parentTreeId, "Untitled.md", "");
      setActiveId(doc.id);
      void engine.persistTreeIncremental();
      void engine.persistDocumentIncremental(doc.id);
      refreshNotes(engine);
    },
    [engine, refreshNotes],
  );

  const onCreateGraph = useCallback(
    (parentTreeId?: TreeID) => {
      if (!engine || !requireWriter()) return;
      const doc = engine.createDocument(parentTreeId, "Untitled Graph.md", emptyGraphMarkdown());
      setActiveId(doc.id);
      void engine.persistTreeIncremental();
      void engine.persistDocumentIncremental(doc.id);
      refreshNotes(engine);
    },
    [engine, refreshNotes],
  );

  const onCreateFolder = useCallback(
    (parentTreeId: TreeID | undefined, name: string) => {
      if (!engine || !requireWriter()) return;
      try {
        engine.createFolder(parentTreeId, name);
        void engine.persistTreeIncremental();
        refreshNotes(engine);
        toast.success("Folder created");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't create folder");
      }
    },
    [engine, refreshNotes],
  );

  // OS capture entry points (SPEC: shortcuts, share target, file handlers)
  // all funnel through `?action=` on the shell URL rather than a bespoke
  // route each — manifest.webmanifest's `shortcuts` and `share_target`
  // redirect here, and VaultApp is already the one place that owns engine
  // readiness. Runs once the vault is loaded and the URL-restore effect
  // above has had its turn, so a share doesn't race the initial note
  // reopen into fighting URL updates. `actionHandled` guards against
  // Strict Mode's double effect invocation re-running a share pickup twice.
  const actionHandled = useRef(false);
  useEffect(() => {
    if (!engine || !urlRestored.current || actionHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    if (!action) return;

    const stripAction = () => {
      params.delete("action");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
      );
    };

    // Deferred a tick (rather than called straight from the effect body) so
    // the create/open action's own state updates land in their own render
    // instead of piling onto the one this effect ran in.
    if (action === "new") {
      actionHandled.current = true;
      queueMicrotask(onCreateNote);
      stripAction();
    } else if (action === "new-graph") {
      actionHandled.current = true;
      queueMicrotask(onCreateGraph);
      stripAction();
    } else if (action === "search") {
      actionHandled.current = true;
      queueMicrotask(() => setCommandOpen(true));
      stripAction();
    } else if (action === "share") {
      actionHandled.current = true;
      (async () => {
        try {
          const cache = await caches.open("adhd-share-pending");
          const res = await cache.match("share-pending");
          if (!res) return;
          await cache.delete("share-pending");
          const payload = (await res.json()) as SharePayload;
          let lastId: string | null = null;
          for (const capture of shareToCaptures(payload)) {
            const doc = await captureToInbox(engine, capture.name, capture.markdown);
            lastId = doc.id;
          }
          if (lastId) setActiveId(lastId);
          refreshNotes(engine);
          toast.success("Shared into Inbox");
        } catch (e) {
          console.error(e);
          toast.error("Couldn't save the shared content");
        } finally {
          stripAction();
        }
      })();
    }
  }, [engine, onCreateNote, onCreateGraph, refreshNotes]);

  // File double-clicked/"Open with"-ed on the OS (manifest.webmanifest's
  // `file_handlers`) arrives here instead of `?action`'s query string —
  // the browser hands the file handle(s) to this queue rather than
  // encoding file content in the URL. Registering the consumer is a no-op
  // unless the app was actually launched this way.
  useEffect(() => {
    if (!engine || !window.launchQueue) return;
    window.launchQueue.setConsumer(async (params) => {
      if (params.files.length === 0) return;
      try {
        let lastId: string | null = null;
        for (const handle of params.files) {
          const file = await handle.getFile();
          const text = await file.text();
          const doc = await captureToInbox(engine, file.name, text);
          lastId = doc.id;
        }
        if (lastId) setActiveId(lastId);
        refreshNotes(engine);
        toast.success(params.files.length > 1 ? "Files added to Inbox" : "File added to Inbox");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't open the file");
      }
    });
  }, [engine, refreshNotes]);

  const onRenameNote = useCallback(
    async (id: string, title: string) => {
      if (!engine || !requireWriter()) return;
      try {
        // Renames the file only (tree node name) — content is never
        // touched, so the note can't be orphaned by editing its heading.
        await engine.renameDocument(id, title);
        await engine.persistTreeIncremental();
        refreshNotes(engine);
        toast.success("Note renamed");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't rename note");
      }
    },
    [engine, refreshNotes],
  );

  const onDeleteNote = useCallback(
    async (id: string) => {
      if (!engine || !requireWriter()) return;
      try {
        await engine.deleteDocument(id);
        setActiveId((cur) => (cur === id ? null : cur));
        refreshNotes(engine);
        toast.success("Note deleted");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't delete note");
      }
    },
    [engine, refreshNotes],
  );

  const onRenameFolder = useCallback(
    async (treeId: TreeID, name: string) => {
      if (!engine || !requireWriter()) return;
      try {
        await engine.renameFolder(treeId, name);
        await engine.persistTreeIncremental();
        refreshNotes(engine);
        toast.success("Folder renamed");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't rename folder");
      }
    },
    [engine, refreshNotes],
  );

  const onDeleteFolder = useCallback(
    async (treeId: TreeID) => {
      if (!engine || !requireWriter()) return;
      try {
        const folder = findFolder(rows, treeId);
        const containedIds = folder ? flattenNotes([folder]).map((n) => n.id) : [];
        await engine.deleteFolder(treeId);
        setActiveId((cur) => (cur && containedIds.includes(cur) ? null : cur));
        refreshNotes(engine);
        toast.success("Folder deleted");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't delete folder");
      }
    },
    [engine, refreshNotes, rows],
  );

  const onMove = useCallback(
    async ({ treeId, newParent, index }: { treeId: TreeID; newParent: TreeID | undefined; index: number }) => {
      if (!engine || !requireWriter()) return;
      try {
        await engine.moveNode(treeId, newParent, index);
        await engine.persistTreeIncremental();
        refreshNotes(engine);
      } catch (e) {
        console.error(e);
        toast.error("Couldn't move item");
      }
    },
    [engine, refreshNotes],
  );

  const activeNote = notes.find((n) => n.id === activeId);
  const activeTitle = activeNote?.title ?? (engine ? null : "Loading…");
  const pluginActiveNote: NoteContext | null = activeId
    ? { documentId: activeId, isGraph: activeNote?.isGraph ?? false }
    : null;
  const isWriterTab = Boolean(engine?.releaseWriterLock);

  const onRemoteSyncChange = useCallback(() => {
    if (engine) refreshNotes(engine);
  }, [engine, refreshNotes]);

  return (
    <SyncProvider engine={engine} onRemoteChange={onRemoteSyncChange}>
    <SidebarProvider className="h-full">
    <VaultPluginBridge
      engine={engine}
      onCreateNote={onCreateNote}
      onCreateGraph={onCreateGraph}
      onCreateFolder={() => setNewFolderOpen(true)}
      activeNote={pluginActiveNote}
      onOpenNote={setActiveId}
      onNotesChanged={() => engine && refreshNotes(engine)}
      readOnly={!isWriterTab}
      onManagePlugins={() => setPluginsDialogOpen(true)}
    >
      <AppSidebar
        rows={rows}
        activeId={activeId}
        engine={engine}
        onCreate={onCreateNote}
        onCreateGraph={onCreateGraph}
        onCreateFolder={onCreateFolder}
        onSelect={setActiveId}
        onRenameNote={onRenameNote}
        onDeleteNote={onDeleteNote}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
        onMove={onMove}
        onOpenCommandMenu={() => setCommandOpen(true)}
        newFolderOpen={newFolderOpen}
        onNewFolderOpenChange={setNewFolderOpen}
      />
      <SidebarInset className="flex min-w-0 flex-1 flex-col">
        <VaultAccessBanner engine={engine} />
        <header className="app-titlebar wco-drag flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
          <SidebarTrigger className="wco-no-drag size-10 md:size-8" />
          <Separator orientation="vertical" className="h-5" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              {activeTitle ? (
                <>
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      render={
                        <button
                          type="button"
                          className="wco-no-drag"
                          onClick={() => setActiveId(null)}
                        />
                      }
                    >
                      Vault
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate" aria-live="polite">
                      {activeTitle}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              ) : (
                <BreadcrumbItem>
                  <BreadcrumbPage>Vault</BreadcrumbPage>
                </BreadcrumbItem>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="wco-no-drag ml-auto flex items-center gap-2">
            <span aria-live="polite" className="contents">
              {activeId && saving !== "idle" && (
                <Badge
                  variant={
                    saving === "saved" ? "secondary" : saving === "error" ? "destructive" : "outline"
                  }
                  className="animate-in fade-in-0 motion-reduce:animate-none"
                >
                  {saving === "saving" ? (
                    <Spinner data-icon="inline-start" />
                  ) : saving === "saved" ? (
                    <Check data-icon="inline-start" />
                  ) : saving === "error" ? (
                    <TriangleAlert data-icon="inline-start" />
                  ) : null}
                  {SAVE_LABEL[saving]}
                </Badge>
              )}
            </span>
            <ModeToggle />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-lg"
                    onClick={() => onCreateNote()}
                    aria-label="New note"
                    className="size-10 md:size-9"
                    disabled={!engine?.releaseWriterLock}
                  >
                    <Plus />
                  </Button>
                }
              />
              <TooltipContent>New note</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <main className="min-h-0 flex-1">
          {error ? (
            <VaultError message={error} />
          ) : !engine ? (
            <VaultLoading />
          ) : activeId ? (
            activeNote?.isGraph ? (
              <GraphEditor
                engine={engine}
                documentId={activeId}
                readOnly={!engine.releaseWriterLock}
                onDirtyChange={(dirty) =>
                  setSaving((prev) =>
                    prev === "error" ? prev : dirty ? "dirty" : prev === "dirty" ? "saving" : prev,
                  )
                }
                onPersisted={onPersisted}
                onSaveError={onSaveError}
                saveRequest={saveRequest}
              />
            ) : (
              <NoteEditor
                engine={engine}
                documentId={activeId}
                readOnly={!engine.releaseWriterLock}
                onDirtyChange={(dirty) =>
                  setSaving((prev) =>
                    // Keep the error visible until a verified save clears it.
                    prev === "error" ? prev : dirty ? "dirty" : prev === "dirty" ? "saving" : prev,
                  )
                }
                onPersisted={onPersisted}
                onSaveError={onSaveError}
                saveRequest={saveRequest}
              />
            )
          ) : (
            <VaultEmpty onCreate={onCreateNote} disabled={!engine?.releaseWriterLock} />
          )}
        </main>
      </SidebarInset>

      {engine && (
        <CommandMenu
          open={commandOpen}
          onOpenChange={setCommandOpen}
          notes={notes}
          onSelectNote={setActiveId}
        />
      )}
      <PluginsDialog open={pluginsDialogOpen} onOpenChange={setPluginsDialogOpen} />
    </VaultPluginBridge>
    </SidebarProvider>
    </SyncProvider>
  );
}

function VaultLoading() {
  return (
    <div className="space-y-3 p-4">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

function GraphLoading() {
  return (
    <div className="space-y-3 p-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-[60vh] w-full" />
    </div>
  );
}

function VaultEmpty({ onCreate, disabled }: { onCreate: () => void; disabled?: boolean }) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <Inbox />
      </EmptyMedia>
      <EmptyTitle>Nothing open</EmptyTitle>
      <Button size="lg" onClick={onCreate} disabled={disabled}>
        <Plus data-icon="inline-start" />
        New note
      </Button>
    </Empty>
  );
}

function VaultError({ message }: { message: string }) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <TriangleAlert className="text-destructive" />
      </EmptyMedia>
      <EmptyTitle>Could not open the vault</EmptyTitle>
      <EmptyDescription className="break-words">{message}</EmptyDescription>
      <Button
        variant="outline"
        size="lg"
        onClick={() => typeof window !== "undefined" && window.location.reload()}
      >
        Reload
      </Button>
    </Empty>
  );
}
