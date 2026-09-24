"use client";

import { OPEN_VAULTS_EVENT } from "@/components/vault/VaultSwitcher";
import { markBoot } from "@/lib/core/boot-marks";
import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TreeID } from "loro-crdt";
import { Check, Circle, FileWarning, Link2, Plus, Search, TriangleAlert } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { NoteEditor } from "@/components/editor/NoteEditor";
import { detectGraphDocument, emptyGraphMarkdown } from "@/lib/graph/detect";
import { AppSidebar, type BinaryRow, type FolderRow, type NoteRow, type SidebarRow } from "./AppSidebar";
import { sortSidebarRows } from "./sidebar-order";
import { COLLECTIONS, LibraryView, type LibraryCollection } from "./LibraryView";
import { NoteSurface } from "./NoteSurface";
import { BacklinksPanel } from "./BacklinksPanel";
import { ModeToggle } from "@/components/mode-toggle";
import type { VaultEngine } from "@/lib/vault/engine";
import { SyncProvider } from "@/lib/browser/sync-context";
import { VaultAccessBanner } from "./VaultAccessBanner";
import { captureToInbox, ensureInbox, INBOX_FOLDER_NAME } from "@/lib/vault/inbox";
import { setAppBadge } from "@/lib/browser/pwa";
import { shareToCaptures, type SharePayload } from "@/lib/vault/share-payload";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { vaultPluginStorage } from "@/lib/plugins/vault-storage";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { PluginHostProvider } from "@/lib/plugins/react";
import type { App, NoteContext, NoteCreationOptions } from "@/lib/plugins/api";
import { useSidebar } from "@/components/ui/sidebar";
import { useSync } from "@/lib/browser/sync-context";
import { useTheme } from "next-themes";
import { Archive, Download, Laptop, Library, Puzzle } from "lucide-react";
import { APP_THEMES } from "@/lib/themes";
import { BUNDLED_PLUGINS } from "@/plugins";
import {
  DEFAULT_PLUGIN_FEATURES,
  getPluginFeatures,
  isCollectionEnabled,
  type PluginFeatures,
} from "@/lib/plugins/features";
import type { resolveWikilink, listWikilinkCandidates } from "@/lib/vault/wikilink";
import { PluginsDialog } from "@/components/plugins/PluginsDialog";
import { TemplatesDialog, type TemplateDialogMode } from "@/components/plugins/TemplatesDialog";
import type { Template } from "@/plugins/core-templates";
import type { CreateHandler, CreateRequest } from "./create-actions";
import { ActiveEditorRegistry } from "@/lib/editor/active-registry";
import {
  createEmptyWorkspaceSnapshot,
  collectTabs,
  LocalStorageWorkspacePersistence,
  type WorkspaceOpenMode,
  resourceKey,
  type WorkspaceStore,
  type WorkspaceTab,
  WorkspaceStore as WorkspaceStateStore,
} from "@/lib/workspace/store";
import { findActiveTab, WorkspaceView } from "./WorkspaceView";
import { AssetViewer } from "./AssetViewer";
import { AttachmentPreviewCache } from "@/lib/vault/attachments";
import { ObsidianImportDialog } from "./ObsidianImportDialog";
import {
  importObsidianVault,
  type ObsidianImportEntry,
  type ObsidianImportProgress,
  type ObsidianImportReport,
} from "@/lib/vault/obsidian-import";

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
const QuickSwitcher = dynamic(
  () => import("./QuickSwitcher").then((mod) => mod.QuickSwitcher),
  { ssr: false },
);

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const SAVE_LABEL: Record<Exclude<SaveState, "idle">, string> = {
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Not saved",
};

/** How long the "Saved" confirmation lingers before hiding. */
const SAVED_VISIBLE_MS = 1500;
const EMPTY_WORKSPACE_SNAPSHOT = createEmptyWorkspaceSnapshot();
const NOOP_SUBSCRIBE = () => () => {};
const getEmptyWorkspaceSnapshot = () => EMPTY_WORKSPACE_SNAPSHOT;

/**
 * Build the nested folder/note tree for the sidebar, with folders first and
 * files sorted by their visible name at every level.
 * The displayed title is always the tree node's file name (minus `.md`) —
 * never frontmatter `title:` or an `# H1` in the body. Those can be edited
 * or deleted freely without the note vanishing or being relabeled out from
 * under the user; only a rename (which renames the file) changes the title.
 */
function toRow(node: VaultTreeNode, tree: VaultTree, engine: VaultEngine, parentPath = ""): SidebarRow {
  if (node.kind === "directory") {
    return {
      treeId: node.treeId,
      kind: "directory",
      name: node.name,
      children: tree.children(node.treeId).map((child) => toRow(child, tree, engine, `${parentPath}${node.name}/`)),
    };
  }
  if (node.kind === "binary") {
    const path = `${parentPath}${node.name}`;
    const row: BinaryRow = {
      treeId: node.treeId,
      kind: "binary",
      id: String(node.treeId),
      title: node.name,
      path,
      sha256: node.sha256,
    };
    return row;
  }
  const doc = node.documentId ? engine.getDocument(node.documentId) : undefined;
  const isGraph = doc ? detectGraphDocument(doc.getMarkdown()) !== null : false;
  return {
    treeId: node.treeId,
    kind: "markdown",
    id: node.documentId ?? node.treeId,
    title: node.name.replace(/\.md$/i, ""),
    path: `${parentPath}${node.name}`,
    isGraph,
  };
}

function buildRootRows(tree: VaultTree, engine: VaultEngine): SidebarRow[] {
  return sortSidebarRows(tree.roots().map((node) => toRow(node, tree, engine)));
}

function flattenNotes(rows: SidebarRow[]): NoteRow[] {
  const out: NoteRow[] = [];
  for (const row of rows) {
    if (row.kind === "markdown") out.push(row);
    else if (row.kind === "directory") out.push(...flattenNotes(row.children));
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
  onCreate,
  onCaptureThought,
  onOpenNewFolder,
  onManagePlugins,
  onManageTemplates,
  onOpenTemplatePicker,
  activeNote,
  focusedTabId,
  onOpenNote,
  onNotesChanged,
  readOnly,
  children,
}: {
  engine: VaultEngine | null;
  onCreate: CreateHandler;
  onCaptureThought: () => Promise<string>;
  onOpenNewFolder: () => void;
  /** Opens `PluginsDialog` (Task 11); a no-op until that dialog exists. */
  onManagePlugins?: () => void;
  onManageTemplates?: () => void;
  onOpenTemplatePicker?: () => void;
  /** The note in the focused workspace tab. */
  activeNote: NoteContext | null;
  focusedTabId: string | null;
  onOpenNote: (id: string) => void;
  onNotesChanged: () => void;
  /** This tab doesn't hold the writer lock (§12) — block wikilink note creation. */
  readOnly: boolean;
  children: (features: PluginFeatures) => ReactNode;
}) {
  const { toggleSidebar } = useSidebar();
  const { setDialogOpen: setSyncDialogOpen } = useSync();
  const { setTheme } = useTheme();

  const commandRegistry = useMemo(() => new CommandRegistry(), []);
  const fallbackHost = useMemo(() => new PluginHost(makeNoopApp(), new InMemoryPluginStorage()), []);
  const [host, setHost] = useState<PluginHost | null>(null);
  const activeHost = host ?? fallbackHost;
  const [pluginFeatures, setPluginFeatures] = useState<PluginFeatures>(DEFAULT_PLUGIN_FEATURES);

  useEffect(() => {
    const updateFeatures = () => setPluginFeatures(getPluginFeatures(activeHost.getSnapshot()));
    updateFeatures();
    return activeHost.subscribe(updateFeatures);
  }, [activeHost]);

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

  // Split panes can mount several CodeMirror views at once. Keep the editor
  // registry separate from the workspace tree: it is a live DOM concern, not
  // persisted vault state.
  const activeEditors = useMemo(() => new ActiveEditorRegistry(), []);
  const attachmentCache = useMemo(
    () => (engine ? new AttachmentPreviewCache(engine) : null),
    [engine],
  );
  useEffect(() => () => attachmentCache?.dispose(), [attachmentCache]);

  const appImpl: App = useMemo<App>(
    () => ({
      commands: {
        list: () => commandRegistry.list(activeNote),
        execute: (fullId) => {
          void commandRegistry.execute(fullId, activeNote, activeEditors.get(focusedTabId), notify);
        },
      },
      workspace: {
        getActiveNote: (): NoteContext | null => activeNote,
        getActiveEditorView: () => activeEditors.get(focusedTabId) ?? activeEditors.getFocused(),
        setActiveEditorView: (view, workspaceTabId) => {
          if (workspaceTabId) activeEditors.set(workspaceTabId, view);
          else if (!view) activeEditors.clear();
        },
        focusEditorTab: (workspaceTabId) => {
          activeEditors.focus(workspaceTabId);
        },
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
          if (name === "templates") {
            onManageTemplates?.();
            return;
          }
          if (name === "templates:create") {
            onOpenTemplatePicker?.();
            return;
          }
        },
        resolveWikilink: (target: string) =>
          engine && wikilinkModRef.current
            ? wikilinkModRef.current.resolveWikilink(engine.tree, target, activeNote?.documentId ?? "")
            : undefined,
        getWikilinkCandidates: () =>
          engine && wikilinkModRef.current ? wikilinkModRef.current.listWikilinkCandidates(engine.tree) : [],
        resolveAttachment: (target: string, documentId?: string) =>
          attachmentCache?.resolve(target, documentId ?? activeNote?.documentId),
        loadAttachment: (target: string, documentId?: string) =>
          attachmentCache?.load(target, documentId ?? activeNote?.documentId) ?? Promise.resolve(undefined),
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
        createNote: async (options?: NoteCreationOptions) => {
          return (await onCreate({ kind: "note", options })) ?? "";
        },
        captureThought: async () => {
          if (!pluginFeatures.inbox) return "";
          return onCaptureThought();
        },
        createGraph: async () => {
          return (await onCreate({ kind: "graph" })) ?? "";
        },
        createFolder: async (name: string) => {
          if (!name.trim()) {
            onOpenNewFolder();
            return;
          }
          await onCreate({ kind: "folder", name });
        },
        read: async () => null,
        list: () => [],
      },
      notify,
    }),
    [
      activeNote,
      activeEditors,
      attachmentCache,
      commandRegistry,
      engine,
      focusedTabId,
      notify,
      onCreate,
      onCaptureThought,
      pluginFeatures.inbox,
      onManagePlugins,
      onManageTemplates,
      onNotesChanged,
      onOpenNewFolder,
      onOpenNote,
      onOpenTemplatePicker,
      readOnly,
      setSyncDialogOpen,
      toggleSidebar,
    ],
  );

  // Plugins keep the `app` they were constructed with for their whole
  // lifetime, and NoteEditor must not rebuild when it changes — so expose one
  // stable object whose methods always forward to the latest implementation.
  const appImplRef = useRef(appImpl);
  useLayoutEffect(() => {
    appImplRef.current = appImpl;
  }, [appImpl]);
  // The ref is only dereferenced when a plugin calls a method, never during render.
  // eslint-disable-next-line react-hooks/refs
  const [app] = useState(() => forwardingApp(appImplRef));

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
      // Synchronous: unwinds anything already committed to the shared
      // CommandRegistry/EditorExtensionRegistry and marks in-flight
      // enable() calls (e.g. from StrictMode's double-invoke) to roll back
      // instead of racing a fresh host's registrations (PluginHost.dispose
      // doc comment has the full race).
      newHost.dispose();
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
        id: "manage-vaults",
        name: "Vaults: Switch or manage",
        icon: Library,
        keywords: ["vault", "switch", "new vault", "delete vault", "import backup"],
        callback: () => {
          window.dispatchEvent(new Event(OPEN_VAULTS_EVENT));
        },
      }),
      commandRegistry.add("core-commands", {
        id: "export-vault",
        name: "Export vault (Markdown and attachments)",
        icon: Download,
        keywords: ["zip", "download", "portable"],
        callback: () => void downloadVaultExport("portable"),
      }),
      commandRegistry.add("core-commands", {
        id: "export-backup",
        name: "Export full backup",
        icon: Archive,
        keywords: ["zip", "download", "history", "restore"],
        callback: () => void downloadVaultExport("full"),
      }),
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

  // Dispatch registered command hotkeys (Command.hotkeys, via
  // PluginHost.hotkeys) globally. ⌘K itself stays hard-wired inside
  // CommandMenu.tsx (spec §2) and is never registered as a default here, so
  // there's no collision. Plain text inputs (search boxes, dialogs) opt out
  // so typing isn't hijacked; the CodeMirror editor's own contenteditable
  // host is NOT excluded, since editorCallback commands need to fire while
  // the editor has focus too — app.commands.execute already threads the
  // active EditorView through (see setActiveEditorView above) so a matched
  // editorCallback command still gets a real (EditorView, NoteContext) pair
  // without a separate CodeMirror-level keymap.
  useEffect(() => {
    if (!host) return;
    const platform = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "mac" : "other";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const matches = host.hotkeys.handleKeydown(e, platform);
      if (matches.length === 0) return;
      e.preventDefault();
      for (const fullId of matches) app.commands.execute(fullId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [host, app]);

  return (
    <PluginHostProvider host={host ?? fallbackHost} commands={commandRegistry} app={app} activeNote={activeNote}>
      {children(pluginFeatures)}
    </PluginHostProvider>
  );
}

/**
 * Build a vault export (SPEC §40) and hand it to the browser as a download.
 * "portable" is the notes and attachments; "full" adds the `.methyl/`
 * metadata so a restore keeps note identity and history.
 */
async function downloadVaultExport(mode: "portable" | "full"): Promise<void> {
  const pending = toast.loading(mode === "full" ? "Preparing full backup…" : "Preparing export…");
  try {
    const [{ exportVaultZip, exportFileName }, { getVaultFileSystem }] = await Promise.all([
      import("@/lib/vault/export"),
      import("@/lib/browser/vault"),
    ]);
    const blob = await exportVaultZip(getVaultFileSystem(), mode);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportFileName(mode);
    anchor.click();
    // Give the download a moment to start before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast.success(mode === "full" ? "Full backup downloaded" : "Vault exported", { id: pending });
  } catch (error) {
    console.error("[export] failed", error);
    toast.error("Export failed — see the console for details", { id: pending });
  }
}

/**
 * An `App` whose every namespace method delegates to `latest.current` at
 * call time. Exported for the identity-stability regression test (Task A1,
 * docs/superpowers/plans/2026-09-18-plugins-roadmap.md) — VaultPluginBridge
 * hands one of these to `PluginHostProvider` and keeps `latest` pointed at
 * the freshly rebuilt `appImpl` on every render, so `useApp()`'s return
 * value never changes identity even though what it delegates to does.
 */
export function forwardingApp(latest: { readonly current: App }): App {
  const get = () => latest.current;
  const ns = <K extends "commands" | "workspace" | "vault">(key: K): App[K] =>
    new Proxy({} as App[K], {
      get: (_t, prop) => {
        const target = get()[key] as Record<PropertyKey, unknown>;
        const value = target[prop];
        return typeof value === "function"
          ? (...args: unknown[]) => (get()[key] as Record<PropertyKey, (...a: unknown[]) => unknown>)[prop](...args)
          : value;
      },
      has: (_t, prop) => prop in (get()[key] as object),
    });
  return {
    commands: ns("commands"),
    workspace: ns("workspace"),
    vault: ns("vault"),
    notify: (...args) => get().notify(...args),
  };
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
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [error, setError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [pluginsDialogOpen, setPluginsDialogOpen] = useState(false);
  const [obsidianImportOpen, setObsidianImportOpen] = useState(false);
  const [templateDialogMode, setTemplateDialogMode] = useState<TemplateDialogMode | null>(null);
  const [templateParentTreeId, setTemplateParentTreeId] = useState<TreeID | undefined>(undefined);
  const [saveRequest, setSaveRequest] = useState<{ nonce: number; documentId: string } | null>(null);
  const [capturePending, setCapturePending] = useState(false);
  const [editorFocusRequest, setEditorFocusRequest] = useState<{ nonce: number; tabId: string } | null>(null);

  const workspaceStore = useMemo<WorkspaceStore | null>(
    () =>
      engine
        ? new WorkspaceStateStore({
            vaultId: engine.vaultId,
            persistence: new LocalStorageWorkspacePersistence(),
          })
        : null,
    [engine],
  );
  const workspaceSnapshot = useSyncExternalStore(
    workspaceStore?.subscribe ?? NOOP_SUBSCRIBE,
    workspaceStore?.getSnapshot ?? getEmptyWorkspaceSnapshot,
    () => EMPTY_WORKSPACE_SNAPSHOT,
  );
  const focusedTab = findActiveTab(workspaceSnapshot);
  const focusedResource = focusedTab?.resource;
  const activeId = focusedResource?.kind === "document" ? focusedResource.documentId : null;
  const activeResourceKey = resourceKey(focusedResource ?? null);
  const focusedTabId = focusedTab?.id ?? null;
  const focusedCollection: LibraryCollection | null = focusedResource
    ? null
    : focusedTab?.collection ?? "notes";

  const openDocument = useCallback(
    (documentId: string, mode: WorkspaceOpenMode = "replace", paneId?: string): string => {
      setEditorFocusRequest(null);
      return workspaceStore?.open({ kind: "document", documentId }, { mode, paneId }) ?? "";
    },
    [workspaceStore],
  );

  const openAsset = useCallback(
    (treeId: TreeID, mode: WorkspaceOpenMode = "replace", paneId?: string): string => {
      setEditorFocusRequest(null);
      return workspaceStore?.open({ kind: "asset", treeId: String(treeId) }, { mode, paneId }) ?? "";
    },
    [workspaceStore],
  );

  const pruneWorkspace = useCallback(
    (eng: VaultEngine) => {
      workspaceStore?.prune([
        ...eng.tree.documentIds().map((documentId) => ({ kind: "document" as const, documentId })),
        ...eng.tree
          .allNodes()
          .filter((node) => node.kind === "binary")
          .map((node) => ({ kind: "asset" as const, treeId: String(node.treeId) })),
      ]);
    },
    [workspaceStore],
  );

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
    const inbox = rows.find(
      (r): r is FolderRow => r.kind === "directory" && r.name.toLowerCase() === INBOX_FOLDER_NAME.toLowerCase(),
    );
    const count = inbox ? inbox.children.filter((c) => c.kind === "markdown").length : 0;
    void setAppBadge(count);
  }, [rows]);

  useEffect(() => {
    let cancelled = false;
    let removeVaultChangedListener: (() => void) | undefined;
    markBoot("boot-start");
    // Dynamic import keeps loro-crdt WASM out of the prerender module graph
    // (note-path.ts pulls it in transitively via vault/engine.ts).
    Promise.all([
      import("@/lib/browser/vault"),
      import("@/lib/vault/engine"),
      import("@/lib/vault/note-path"),
    ])
      .then(async ([{ getVault, VAULT_CHANGED_EVENT }, , notePath]) => {
        markBoot("modules-loaded");
        const eng = await getVault();
        if (cancelled) return;
        notePathRef.current = notePath;
        setEngine(eng);
        markBoot("engine-ready");
        // Notes load in the background; rows that depend on content (graph
        // notes) are refreshed once they're all in.
        void eng.whenAllDocumentsLoaded().then(() => {
          if (!cancelled) refreshNotes(eng);
        });
        // The startup reconcile also runs in the background and may adopt
        // or fix notes after the tree was first shown.
        const onVaultChanged = () => refreshNotes(eng);
        window.addEventListener(VAULT_CHANGED_EVENT, onVaultChanged);
        removeVaultChangedListener = () => window.removeEventListener(VAULT_CHANGED_EVENT, onVaultChanged);
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      removeVaultChangedListener?.();
    };
  }, [refreshNotes]);

  // Once the workspace store is mounted, prune persisted tabs against the
  // current tree and let a human-readable URL override only the focused tab.
  // Other persisted tabs/splits survive a reload.
  useEffect(() => {
    if (!engine || !workspaceStore || !notePathRef.current) return;
    refreshNotes(engine);
    pruneWorkspace(engine);
    const wanted = notePathRef.current.notePathFromLocation(window.location.pathname, engine.vaultId);
    if (wanted) {
      const found = notePathRef.current.docIdForPath(engine.tree, wanted);
      if (found) workspaceStore.replaceFromDeepLink({ kind: "document", documentId: found });
    }
    urlRestored.current = true;
  }, [engine, pruneWorkspace, refreshNotes, workspaceStore]);

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

  const notesRef = useRef(notes);
  useLayoutEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  const saveErrorShown = useRef(new Set<string>());
  const savingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const setDocumentSaveState = useCallback((documentId: string, state: SaveState) => {
    setSaveStates((previous) => ({ ...previous, [documentId]: state }));
  }, []);

  const onPersisting = useCallback((documentId: string) => {
    const existing = savingTimers.current.get(documentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      savingTimers.current.delete(documentId);
      setSaveStates((previous) => {
        if (previous[documentId] !== "dirty" && previous[documentId] !== "error") return previous;
        return { ...previous, [documentId]: "saving" };
      });
    }, 250);
    savingTimers.current.set(documentId, timer);
  }, []);

  const onSaveError = useCallback((documentId: string) => {
    const title = notesRef.current.find((note) => note.id === documentId)?.title ?? "this note";
    if (!saveErrorShown.current.has(documentId)) {
      saveErrorShown.current.add(documentId);
      toast.error(`Changes to “${title}” weren't saved. Copy your text before reloading.`);
    }
    const timer = savingTimers.current.get(documentId);
    if (timer) clearTimeout(timer);
    savingTimers.current.delete(documentId);
    setDocumentSaveState(documentId, "error");
  }, [setDocumentSaveState]);

  const onPersisted = useCallback((documentId: string) => {
    const timer = savingTimers.current.get(documentId);
    if (timer) clearTimeout(timer);
    savingTimers.current.delete(documentId);
    saveErrorShown.current.delete(documentId);
    setDocumentSaveState(documentId, "saved");
    setTimeout(() => {
      setSaveStates((previous) =>
        previous[documentId] === "saved" ? { ...previous, [documentId]: "idle" } : previous,
      );
    }, SAVED_VISIBLE_MS);
  }, [setDocumentSaveState]);

  const onEditorDirtyChange = useCallback((documentId: string, dirty: boolean) => {
    if (!dirty) return;
    setSaveStates((previous) => ({
      ...previous,
      [documentId]: previous[documentId] === "error" ? "error" : "dirty",
    }));
  }, []);

  // Cmd/Ctrl+S targets focused writable document only. Editors in other panes
  // receive the request object but ignore a different documentId.
  const isWriter = Boolean(engine?.releaseWriterLock);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!engine || !activeId || !isWriter) return;
        setSaveRequest((previous) => ({ nonce: (previous?.nonce ?? 0) + 1, documentId: activeId }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [engine, activeId, isWriter]);

  useEffect(() => () => {
    for (const timer of savingTimers.current.values()) clearTimeout(timer);
  }, []);

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

  const captureInFlight = useRef(false);
  const captureRequestNonce = useRef(0);
  const captureThought = useCallback(async (): Promise<string> => {
    if (captureInFlight.current || !engine || !workspaceStore || !requireWriter()) return "";
    captureInFlight.current = true;
    setCapturePending(true);
    try {
      const inboxId = ensureInbox(engine);
      const doc = engine.createDocument(inboxId, "Untitled.md", "");
      const focused = workspaceStore.getFocusedTab();
      const tabId = workspaceStore.open(
        { kind: "document", documentId: doc.id },
        { mode: focused.resource ? "new" : "replace" },
      );
      setEditorFocusRequest({ nonce: ++captureRequestNonce.current, tabId });
      refreshNotes(engine);
      try {
        await engine.persistTreeIncremental();
        await engine.persistDocumentIncremental(doc.id);
      } catch (error) {
        console.error(error);
        onSaveError(doc.id);
      }
      return doc.id;
    } finally {
      captureInFlight.current = false;
      setCapturePending(false);
    }
  }, [engine, onSaveError, refreshNotes, requireWriter, workspaceStore]);

  const modalOwnsFocus =
    commandOpen ||
    quickSwitcherOpen ||
    backlinksOpen ||
    newFolderOpen ||
    pluginsDialogOpen ||
    obsidianImportOpen ||
    templateDialogMode !== null;
  const activeEditorFocusRequest =
    editorFocusRequest && focusedTabId === editorFocusRequest.tabId && !modalOwnsFocus
      ? editorFocusRequest.nonce
      : null;

  const createNote = useCallback(
    (parentTreeId?: TreeID, options: NoteCreationOptions = {}): string => {
      if (!engine || !requireWriter()) return "";
      // Tree auto-suffixes on a name clash within the folder (Untitled.md
      // -> Untitled 2.md -> ...), so it's always safe to ask for the same
      // base name.
      const doc = engine.createDocument(parentTreeId, options.name ?? "Untitled.md", options.markdown ?? "");
      openDocument(doc.id);
      void engine.persistTreeIncremental();
      void engine.persistDocumentIncremental(doc.id);
      refreshNotes(engine);
      return doc.id;
    },
    [engine, openDocument, refreshNotes, requireWriter],
  );

  const openTemplates = useCallback((mode: TemplateDialogMode, parentTreeId?: TreeID) => {
    setTemplateParentTreeId(parentTreeId);
    setTemplateDialogMode(mode);
  }, []);

  const onTemplateChosen = useCallback(
    (template: Template) => {
      createNote(templateParentTreeId, { markdown: template.content });
    },
    [createNote, templateParentTreeId],
  );

  const createGraph = useCallback(
    (parentTreeId?: TreeID): string => {
      if (!engine || !requireWriter()) return "";
      const doc = engine.createDocument(parentTreeId, "Untitled Graph.md", emptyGraphMarkdown());
      openDocument(doc.id);
      void engine.persistTreeIncremental();
      void engine.persistDocumentIncremental(doc.id);
      refreshNotes(engine);
      return doc.id;
    },
    [engine, openDocument, refreshNotes, requireWriter],
  );

  const createFolder = useCallback(
    (parentTreeId: TreeID | undefined, name: string): void => {
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
    [engine, refreshNotes, requireWriter],
  );

  const onCreate = useCallback<CreateHandler>(
    (request: CreateRequest): string => {
      if (request.kind === "template") {
        openTemplates("create", request.parentTreeId);
        return "";
      }
      if (request.kind === "graph") {
        return createGraph(request.parentTreeId);
      }
      if (request.kind === "folder") {
        createFolder(request.parentTreeId, request.name);
        return "";
      }
      return createNote(request.parentTreeId, request.options);
    },
    [createFolder, createGraph, createNote, openTemplates],
  );

  const runObsidianImport = useCallback(
    async (
      entries: ObsidianImportEntry[],
      onProgress: (progress: ObsidianImportProgress) => void,
    ): Promise<ObsidianImportReport> => {
      if (!engine) throw new Error("Vault is not ready");
      if (!requireWriter()) throw new Error("Vault is read-only");
      const report = await importObsidianVault(engine, entries, onProgress);
      refreshNotes(engine);
      return report;
    },
    [engine, refreshNotes, requireWriter],
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
      queueMicrotask(() => onCreate({ kind: "note" }));
      stripAction();
    } else if (action === "new-graph") {
      actionHandled.current = true;
      queueMicrotask(() => onCreate({ kind: "graph" }));
      stripAction();
    } else if (action === "search") {
      actionHandled.current = true;
      queueMicrotask(() => setCommandOpen(true));
      stripAction();
    } else if (action === "share") {
      actionHandled.current = true;
      (async () => {
        try {
          const cache = await caches.open("methyl-share-pending");
          const res = await cache.match("share-pending");
          if (!res) return;
          await cache.delete("share-pending");
          const payload = (await res.json()) as SharePayload;
          let lastId: string | null = null;
          for (const capture of shareToCaptures(payload)) {
            const doc = await captureToInbox(engine, capture.name, capture.markdown);
            lastId = doc.id;
          }
          if (lastId) openDocument(lastId);
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
  }, [engine, onCreate, openDocument, refreshNotes]);

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
        if (lastId) openDocument(lastId);
        refreshNotes(engine);
        toast.success(params.files.length > 1 ? "Files added to Inbox" : "File added to Inbox");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't open the file");
      }
    });
  }, [engine, openDocument, refreshNotes]);

  const onRenameNote = useCallback(
    async (id: string, title: string) => {
      if (!engine) throw new Error("Vault is not ready");
      if (!requireWriter()) throw new Error("Vault is read-only");
      // Renames file only. Content, selection, scroll, and undo history stay intact.
      await engine.renameDocument(id, title);
      await engine.persistTreeIncremental();
      refreshNotes(engine);
    },
    [engine, refreshNotes, requireWriter],
  );

  const onDeleteNote = useCallback(
    async (id: string) => {
      if (!engine || !requireWriter()) return;
      try {
        await engine.deleteDocument(id);
        if (activeId === id) workspaceStore?.replaceFromDeepLink(null);
        refreshNotes(engine);
        toast.success("Note deleted");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't delete note");
      }
    },
    [activeId, engine, refreshNotes, requireWriter, workspaceStore],
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
    [engine, refreshNotes, requireWriter],
  );

  const onDeleteFolder = useCallback(
    async (treeId: TreeID) => {
      if (!engine || !requireWriter()) return;
      try {
        const folder = findFolder(rows, treeId);
        const containedIds = folder ? flattenNotes([folder]).map((n) => n.id) : [];
        await engine.deleteFolder(treeId);
        if (activeId && containedIds.includes(activeId)) workspaceStore?.replaceFromDeepLink(null);
        refreshNotes(engine);
        toast.success("Folder deleted");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't delete folder");
      }
    },
    [activeId, engine, refreshNotes, requireWriter, rows, workspaceStore],
  );

  const onRenameAsset = useCallback(
    async (treeId: TreeID, name: string) => {
      if (!engine || !requireWriter()) return;
      try {
        await engine.renameAttachment(treeId, name);
        refreshNotes(engine);
        toast.success("Attachment renamed");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't rename attachment");
      }
    },
    [engine, refreshNotes, requireWriter],
  );

  const onDeleteAsset = useCallback(
    async (treeId: TreeID) => {
      if (!engine || !requireWriter()) return;
      try {
        await engine.deleteAttachment(treeId);
        refreshNotes(engine);
        pruneWorkspace(engine);
        toast.success("Attachment deleted");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't delete attachment");
      }
    },
    [engine, pruneWorkspace, refreshNotes, requireWriter],
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
    [engine, refreshNotes, requireWriter],
  );

  const activeNote = notes.find((n) => n.id === activeId);
  const activeTitle = activeNote?.title ?? (engine ? null : "Loading…");
  const backlinks = activeId && engine ? engine.backlinksFor(activeId) : [];
  const pluginActiveNote: NoteContext | null = activeId
    ? { documentId: activeId, isGraph: activeNote?.isGraph ?? false }
    : null;
  const isWriterTab = Boolean(engine?.releaseWriterLock);
  const searchNotes = useCallback(
    (query: string, limit?: number) => engine?.search(query, limit) ?? [],
    [engine],
  );

  const getTabTitle = useCallback(
    (tab: WorkspaceTab): string => {
      if (!tab.resource) return COLLECTIONS[tab.collection ?? "notes"].title;
      if (tab.resource.kind === "asset") {
        return engine?.tree.getNode(tab.resource.treeId as TreeID)?.name ?? "Missing attachment";
      }
      const resource = tab.resource;
      return notes.find((note) => note.id === resource.documentId)?.title ?? "Missing note";
    },
    [engine, notes],
  );

  const renderWorkspaceTab = useCallback(
    (tab: WorkspaceTab, features: PluginFeatures = DEFAULT_PLUGIN_FEATURES): ReactNode => {
      if (!engine || !tab.resource) return null;
      if (tab.resource.kind === "asset") {
        const node = engine.tree.getNode(tab.resource.treeId as TreeID);
        if (!node || node.kind !== "binary") {
          return (
            <UnavailableSurface
              kind="attachment"
              actionLabel={features.allNotes ? COLLECTIONS.notes.title : undefined}
              onAllNotes={features.allNotes ? () => workspaceStore?.openCollection("notes") : undefined}
            />
          );
        }
        return <AssetViewer key={tab.id} engine={engine} treeId={node.treeId} title={node.name} />;
      }
      const documentId = tab.resource.documentId;
      const note = notes.find((candidate) => candidate.id === documentId);
      if (!note) {
        return (
          <UnavailableSurface
            kind="note"
            actionLabel={features.allNotes ? COLLECTIONS.notes.title : undefined}
            onAllNotes={features.allNotes ? () => workspaceStore?.openCollection("notes") : undefined}
          />
        );
      }
      if (note.isGraph) {
        return (
          <GraphEditor
            key={tab.id}
            engine={engine}
            documentId={documentId}
            readOnly={!engine.releaseWriterLock}
            onDirtyChange={onEditorDirtyChange}
            onPersisting={onPersisting}
            onPersisted={onPersisted}
            onSaveError={onSaveError}
            saveRequest={saveRequest}
          />
        );
      }
      return (
        <NoteSurface key={tab.id} note={note} readOnly={!engine.releaseWriterLock} onRename={onRenameNote}>
          <NoteEditor
            key={tab.id}
            engine={engine}
            documentId={documentId}
            workspaceTabId={tab.id}
            focusRequest={activeEditorFocusRequest && focusedTabId === tab.id ? activeEditorFocusRequest : null}
            onAttachmentsChanged={() => refreshNotes(engine)}
            readOnly={!engine.releaseWriterLock}
            onDirtyChange={onEditorDirtyChange}
            onPersisting={onPersisting}
            onPersisted={onPersisted}
            onSaveError={onSaveError}
            saveRequest={saveRequest}
          />
        </NoteSurface>
      );
    },
    [
      activeEditorFocusRequest,
      engine,
      focusedTabId,
      notes,
      onEditorDirtyChange,
      onPersisting,
      onPersisted,
      onRenameNote,
      onSaveError,
      refreshNotes,
      saveRequest,
      workspaceStore,
    ],
  );

  const openCollection = useCallback((collection: LibraryCollection) => {
    setEditorFocusRequest(null);
    workspaceStore?.openCollection(collection);
  }, [workspaceStore]);

  const renderWorkspaceEmpty = useCallback(
    (paneId: string, tabId: string, features: PluginFeatures = DEFAULT_PLUGIN_FEATURES): ReactNode => {
      const tab = collectTabs(workspaceSnapshot.root).find((candidate) => candidate.id === tabId);
      const collection = tab?.collection ?? "notes";
      if (!isCollectionEnabled(collection, features)) {
        return <DisabledCollectionSurface collection={collection} />;
      }
      return (
        <LibraryView
          collection={collection}
          notes={notes}
          recentDocumentIds={workspaceSnapshot.recentDocumentIds}
          onOpen={(id, mode) => openDocument(id, mode, paneId)}
          onCreate={() => {
            workspaceStore?.focusPane(paneId);
            if (!engine?.releaseWriterLock) return;
            onCreate({
              kind: collection === "graphs" ? "graph" : "note",
              parentTreeId: collection === "inbox" ? ensureInbox(engine) : undefined,
            });
          }}
          disabled={!engine?.releaseWriterLock}
        />
      );
    },
    [engine, notes, onCreate, openDocument, workspaceSnapshot, workspaceStore],
  );

  const onRemoteSyncChange = useCallback(() => {
    if (engine) refreshNotes(engine);
  }, [engine, refreshNotes]);
  const activeSaveState: SaveState = activeId ? saveStates[activeId] ?? "idle" : "idle";

  return (
    <SyncProvider engine={engine} onRemoteChange={onRemoteSyncChange}>
    <SidebarProvider className="methyl-app h-full">
    <VaultPluginBridge
      engine={engine}
      onCreate={onCreate}
      onCaptureThought={captureThought}
      onOpenNewFolder={() => setNewFolderOpen(true)}
      activeNote={pluginActiveNote}
      focusedTabId={focusedTabId}
      onOpenNote={openDocument}
      onNotesChanged={() => engine && refreshNotes(engine)}
      readOnly={!isWriterTab}
      onManagePlugins={() => setPluginsDialogOpen(true)}
      onManageTemplates={() => openTemplates("manage")}
      onOpenTemplatePicker={() => openTemplates("create")}
    >{(pluginFeatures) => (
      <>
      <AppSidebar
        rows={rows}
        activeId={activeId}
        activeResourceKey={activeResourceKey}
        engine={engine}
        onCreate={onCreate}
        onRequestImport={() => setObsidianImportOpen(true)}
        onSelect={openDocument}
        onSelectAsset={openAsset}
        onRenameNote={onRenameNote}
        onDeleteNote={onDeleteNote}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
        onRenameAsset={onRenameAsset}
        onDeleteAsset={onDeleteAsset}
        onMove={onMove}
        onOpenCommandMenu={() => setCommandOpen(true)}
        pluginFeatures={pluginFeatures}
        collection={focusedCollection}
        onOpenCollection={(collection) => {
          if (isCollectionEnabled(collection, pluginFeatures)) openCollection(collection);
        }}
        newFolderOpen={newFolderOpen}
        onNewFolderOpenChange={setNewFolderOpen}
      />
      <SidebarInset className="methyl-canvas flex min-w-0 flex-1 flex-col">
        <VaultAccessBanner engine={engine} />
        <header className="app-titlebar wco-drag flex min-h-14 shrink-0 items-center gap-2 bg-background px-3">
          <SidebarTrigger className="wco-no-drag size-11 md:size-8" />
          <div className="min-w-0 flex-1" />
          <div className="wco-no-drag ml-auto flex items-center gap-2">
            <span aria-live="polite" className="save-status-slot">
              {activeId && activeSaveState !== "idle" && (
                <Badge
                  variant={
                    activeSaveState === "saved" ? "secondary" : activeSaveState === "error" ? "destructive" : "outline"
                  }
                  aria-label={SAVE_LABEL[activeSaveState]}
                  title={SAVE_LABEL[activeSaveState]}
                  className="animate-in fade-in-0 motion-reduce:animate-none"
                >
                  {activeSaveState === "saving" ? (
                    <Spinner data-icon="inline-start" />
                  ) : activeSaveState === "saved" ? (
                    <Check data-icon="inline-start" />
                  ) : activeSaveState === "error" ? (
                    <TriangleAlert data-icon="inline-start" />
                  ) : activeSaveState === "dirty" ? (
                    <Circle data-icon="inline-start" />
                  ) : null}
                  {SAVE_LABEL[activeSaveState]}
                </Badge>
              )}
            </span>
            {activeId && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-lg"
                      className="backlinks-trigger relative !size-11 !min-h-11 !min-w-11"
                      aria-label="Show backlinks"
                      aria-expanded={backlinksOpen}
                      aria-haspopup="dialog"
                      onClick={() => setBacklinksOpen(true)}
                    >
                      <Link2 />
                      {backlinks.length > 0 && (
                        <Badge
                          aria-hidden="true"
                          variant="secondary"
                          className="pointer-events-none absolute -top-1 -right-1 min-w-5 px-1"
                        >
                          {backlinks.length > 99 ? "99+" : backlinks.length}
                        </Badge>
                      )}
                    </Button>
                  }
                />
                <TooltipContent>Show backlinks</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    className="header-find wco-no-drag size-11 md:hidden"
                    aria-label="Find notes"
                    aria-expanded={commandOpen}
                    aria-haspopup="dialog"
                    title="Find notes"
                    onClick={() => setCommandOpen(true)}
                  >
                    <Search />
                  </Button>
                }
              />
              <TooltipContent>Find notes</TooltipContent>
            </Tooltip>
            <ModeToggle />
            {pluginFeatures.inbox && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="default"
                      size="icon-lg"
                      className="capture-button wco-no-drag size-11 md:size-9"
                      aria-label="Capture a thought"
                      title="Capture a thought"
                      disabled={!engine?.releaseWriterLock || capturePending}
                      onClick={() => void captureThought()}
                    >
                      <Plus />
                    </Button>
                  }
                />
                <TooltipContent>Capture a thought</TooltipContent>
              </Tooltip>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1">
          {error ? (
            <VaultError message={error} />
          ) : !engine ? (
            <VaultLoading />
          ) : workspaceStore ? (
            <WorkspaceView
              snapshot={workspaceSnapshot}
              store={workspaceStore}
              getTabTitle={getTabTitle}
              renderTab={(tab) => renderWorkspaceTab(tab, pluginFeatures)}
              renderEmpty={(paneId, tabId) => renderWorkspaceEmpty(paneId, tabId, pluginFeatures)}
              onTabActivated={() => setEditorFocusRequest(null)}
            />
          ) : null}
        </main>
      </SidebarInset>

      {engine && activeId && (
        <BacklinksPanel
          open={backlinksOpen}
          onOpenChange={setBacklinksOpen}
          currentTitle={activeTitle ?? "Current note"}
          backlinks={backlinks}
          notes={notes}
          onSelectNote={openDocument}
        />
      )}
      {engine && (
        <CommandMenu
          open={commandOpen}
          onOpenChange={setCommandOpen}
          notes={notes}
          onSelectNote={openDocument}
          searchNotes={searchNotes}
        />
      )}
      {engine && (
        <QuickSwitcher
          open={quickSwitcherOpen}
          onOpenChange={setQuickSwitcherOpen}
          notes={notes}
          recentDocumentIds={workspaceSnapshot.recentDocumentIds}
          onOpenNote={openDocument}
          onCreate={onCreate}
        />
      )}
      <PluginsDialog open={pluginsDialogOpen} onOpenChange={setPluginsDialogOpen} />
      <ObsidianImportDialog
        open={obsidianImportOpen}
        onOpenChange={setObsidianImportOpen}
        onImport={runObsidianImport}
      />
      <TemplatesDialog
        open={templateDialogMode !== null}
        mode={templateDialogMode ?? "create"}
        onOpenChange={(open) => {
          if (!open) {
            setTemplateDialogMode(null);
            setTemplateParentTreeId(undefined);
          }
        }}
        onCreate={onTemplateChosen}
        onManage={() => setTemplateDialogMode("manage")}
      />
      </>
    )}</VaultPluginBridge>
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

function DisabledCollectionSurface({ collection }: { collection: LibraryCollection }) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <FileWarning />
      </EmptyMedia>
      <EmptyTitle>{COLLECTIONS[collection].title} is disabled</EmptyTitle>
      <EmptyDescription>Select a note from the file and folder list in the sidebar.</EmptyDescription>
    </Empty>
  );
}

function UnavailableSurface({
  kind,
  actionLabel,
  onAllNotes,
}: {
  kind: "note" | "attachment";
  actionLabel?: string;
  onAllNotes?: () => void;
}) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <FileWarning />
      </EmptyMedia>
      <EmptyTitle>{kind === "note" ? "This note is unavailable" : "This attachment is unavailable"}</EmptyTitle>
      {actionLabel && onAllNotes ? (
        <Button variant="outline" size="lg" onClick={onAllNotes}>
          {actionLabel}
        </Button>
      ) : null}
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
