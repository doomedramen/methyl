"use client";

import { markBoot } from "@/lib/core/boot-marks";
import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TreeID } from "loro-crdt";
import { toast } from "sonner";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { NoteEditor } from "@/components/editor/NoteEditor";
import { AppSidebar, type FolderRow, type SidebarRow } from "./AppSidebar";
import { COLLECTIONS, LibraryView, type LibraryCollection } from "./LibraryView";
import { NoteSurface } from "./NoteSurface";
import { BacklinksPanel } from "./BacklinksPanel";
import type { VaultEngine } from "@/lib/vault/engine";
import { SyncProvider } from "@/lib/browser/sync-context";
import { VaultAccessBanner } from "./VaultAccessBanner";
import { ensureInbox, INBOX_FOLDER_NAME } from "@/lib/vault/inbox";
import { setAppBadge } from "@/lib/browser/pwa";
import type { NoteContext } from "@/lib/plugins/api";
import {
  DEFAULT_PLUGIN_FEATURES,
  isCollectionEnabled,
  type PluginFeatures,
} from "@/lib/plugins/features";
import { PluginsDialog } from "@/components/plugins/PluginsDialog";
import { TemplatesDialog } from "@/components/plugins/TemplatesDialog";
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
import { ObsidianImportDialog } from "./ObsidianImportDialog";
import { buildRootRows, flattenNotes } from "./vault-rows";
import { VaultPluginBridge } from "./VaultPluginBridge";
import {
  VaultLoading,
  GraphLoading,
  DisabledCollectionSurface,
  UnavailableSurface,
  VaultError,
} from "./VaultSurfaces";
import { useSaveFeedback, type SaveState } from "./use-save-feedback";
import { useCreateActions } from "./use-create-actions";
import { useOsEntryPoints } from "./use-os-entry-points";
import { useTreeActions } from "./use-tree-actions";
import { VaultHeader } from "./VaultHeader";

import { MoveToDialog, type MoveItem } from "./MoveToDialog";

export { forwardingApp } from "./VaultPluginBridge";
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

const EMPTY_WORKSPACE_SNAPSHOT = createEmptyWorkspaceSnapshot();
const NOOP_SUBSCRIBE = () => () => {};
const getEmptyWorkspaceSnapshot = () => EMPTY_WORKSPACE_SNAPSHOT;

export function VaultApp() {
  const [engine, setEngine] = useState<VaultEngine | null>(null);
  const [rows, setRows] = useState<SidebarRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [moveItem, setMoveItem] = useState<MoveItem | null>(null);
  const [pluginsDialogOpen, setPluginsDialogOpen] = useState(false);
  const [obsidianImportOpen, setObsidianImportOpen] = useState(false);
  const [saveRequest, setSaveRequest] = useState<{ nonce: number; documentId: string } | null>(null);
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

  const { saveStates, onPersisting, onSaveError, onPersisted, onEditorDirtyChange } = useSaveFeedback(notes);

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

  const {
    captureThought,
    capturePending,
    onCreate,
    openTemplates,
    onTemplateChosen,
    templateDialogMode,
    setTemplateDialogMode,
    closeTemplates,
    runObsidianImport,
  } = useCreateActions({ engine, workspaceStore, requireWriter, refreshNotes, onSaveError, openDocument, setEditorFocusRequest });

  const modalOwnsFocus =
    commandOpen ||
    quickSwitcherOpen ||
    backlinksOpen ||
    newFolderOpen ||
    moveItem !== null ||
    pluginsDialogOpen ||
    obsidianImportOpen ||
    templateDialogMode !== null;
  const activeEditorFocusRequest =
    editorFocusRequest && focusedTabId === editorFocusRequest.tabId && !modalOwnsFocus
      ? editorFocusRequest.nonce
      : null;

  useOsEntryPoints({ engine, urlRestored, onCreate, openDocument, refreshNotes, setCommandOpen });

  const { onRenameNote, onDeleteNote, onRenameFolder, onDeleteFolder, onRenameAsset, onDeleteAsset, onMove } =
    useTreeActions({ engine, requireWriter, refreshNotes, pruneWorkspace, activeId, workspaceStore, rows });

  const activeNote = notes.find((n) => n.id === activeId);
  const activeTitle = activeNote?.title ?? (engine ? null : "Loading…");
  const backlinks = activeId && engine ? engine.backlinksFor(activeId) : [];
  const pluginActiveNote: NoteContext | null = activeId
    ? { documentId: activeId, isGraph: activeNote?.isGraph ?? false }
    : null;
  const isWriterTab = Boolean(engine?.releaseWriterLock);
  const moveActiveNote = useCallback(() => {
    const node = activeId && engine ? engine.tree.findByDocumentId(activeId) : null;
    if (!node) {
      toast("Open a note to move it.");
      return;
    }
    setMoveItem({ treeId: node.treeId, name: notes.find((n) => n.id === activeId)?.title ?? node.name });
  }, [activeId, engine, notes]);
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
      onMoveActiveNote={moveActiveNote}
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
        onRequestMove={setMoveItem}
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
        <VaultHeader
          activeId={activeId}
          saveState={activeSaveState}
          backlinkCount={backlinks.length}
          backlinksOpen={backlinksOpen}
          onOpenBacklinks={() => setBacklinksOpen(true)}
          commandOpen={commandOpen}
          onOpenCommandMenu={() => setCommandOpen(true)}
          showCapture={pluginFeatures.inbox}
          captureDisabled={!engine?.releaseWriterLock || capturePending}
          onCapture={() => void captureThought()}
        />

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
      <MoveToDialog
        item={moveItem}
        rows={rows}
        onOpenChange={(open) => !open && setMoveItem(null)}
        onMove={(target) => void onMove(target)}
      />
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
          if (!open) closeTemplates();
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
