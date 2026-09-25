"use client";

import { VaultSwitcher } from "@/components/vault/VaultSwitcher";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeID } from "loro-crdt";
import type { VaultEngine } from "@/lib/vault/engine";
import { Inbox, Search, X } from "lucide-react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { PwaStatus } from "@/components/pwa/PwaStatus";
import { CreateMenu } from "./CreateMenu";
import { COLLECTIONS, type LibraryCollection } from "./LibraryView";
import { isCollectionEnabled, type PluginFeatures } from "@/lib/plugins/features";
import { formatHotkey } from "@/lib/plugins/hotkeys";
import type { CreateHandler } from "./create-actions";
import {
  RenameNoteDialog,
  DeleteNoteAlert,
  RenameFolderDialog,
  DeleteFolderAlert,
  RenameAssetDialog,
  DeleteAssetAlert,
  NewFolderDialog,
} from "./NoteActions";
import type { VisibleDndRow } from "./sidebar-dnd";
import {
  afterDropId,
  collectFolderIds,
  countNotes,
  flatten,
  findRow,
  loadCollapsed,
  saveCollapsed,
  type BinaryRow,
  type FlatEntry,
  type FlatRow,
  type FolderRow,
  type MoveTarget,
  type NoteRow,
  type SidebarRow,
} from "./sidebar-rows";
import { DragPreview, EmptyFolderRow, FolderAfterDropZone, Row } from "./SidebarRow";
import { sidebarCollisionDetection, useSidebarDnd } from "./use-sidebar-dnd";

export type { BinaryRow, FolderRow, MoveTarget, NoteRow, SidebarRow } from "./sidebar-rows";
export { computeDropMode } from "./sidebar-dnd";

interface AppSidebarProps {
  rows: SidebarRow[];
  activeId: string | null;
  activeResourceKey?: string | null;
  /** Passed through to the footer status popover for the diagnostics copy action. */
  engine: VaultEngine | null;
  onCreate: CreateHandler;
  onRequestImport: () => void;
  onSelect: (id: string) => void;
  onSelectAsset: (treeId: TreeID) => void;
  onRenameNote: (id: string, title: string) => Promise<void>;
  onDeleteNote: (id: string) => void;
  onRenameFolder: (treeId: TreeID, name: string) => void;
  onDeleteFolder: (treeId: TreeID) => void;
  onRenameAsset: (treeId: TreeID, name: string) => void;
  onDeleteAsset: (treeId: TreeID) => void;
  onMove: (target: MoveTarget) => void;
  onOpenCommandMenu: () => void;
  pluginFeatures: PluginFeatures;
  collection: LibraryCollection | null;
  onOpenCollection: (collection: LibraryCollection) => void;
  newFolderOpen: boolean;
  onNewFolderOpenChange: (open: boolean) => void;
}

export function AppSidebar({
  rows,
  activeId,
  activeResourceKey = null,
  engine,
  onCreate,
  onRequestImport,
  onSelect,
  onSelectAsset,
  onRenameNote,
  onDeleteNote,
  onRenameFolder,
  onDeleteFolder,
  onRenameAsset,
  onDeleteAsset,
  onMove,
  onOpenCommandMenu,
  pluginFeatures,
  collection,
  onOpenCollection,
  newFolderOpen,
  onNewFolderOpenChange,
}: AppSidebarProps) {
  const { setOpenMobile, isMobile, openMobile } = useSidebar();
  const [renameTarget, setRenameTarget] = useState<NoteRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NoteRow | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<FolderRow | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderRow | null>(null);
  const [renameAssetTarget, setRenameAssetTarget] = useState<BinaryRow | null>(null);
  const [deleteAssetTarget, setDeleteAssetTarget] = useState<BinaryRow | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<TreeID | undefined>(undefined);

  const previousOpenMobile = useRef(false);
  useEffect(() => {
    if (previousOpenMobile.current && !openMobile) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('[data-slot="sidebar-trigger"]')?.focus();
      });
    }
    previousOpenMobile.current = openMobile;
  }, [openMobile]);

  const closeMobileSidebar = useCallback(() => {
    setOpenMobile(false);
  }, [setOpenMobile]);

  const requestNewFolder = useCallback(
    (parentTreeId?: TreeID) => {
      setNewFolderParent(parentTreeId);
      onNewFolderOpenChange(true);
    },
    [onNewFolderOpenChange],
  );

  // Collapsed folders, per vault. Until the user toggles one, it's what was
  // saved for this vault, or else the folders that existed when the vault
  // first showed (they start collapsed; folders created later start open).
  const vaultId = engine?.vaultId ?? null;
  const savedCollapsed = useMemo(() => (vaultId ? loadCollapsed(vaultId) : null), [vaultId]);
  const [collapsedChoice, setCollapsedChoice] = useState<{ vaultId: string; folders: Set<string> } | null>(null);
  const [initialFolders, setInitialFolders] = useState<{ vaultId: string; folders: Set<string> } | null>(null);
  if (vaultId && !savedCollapsed && rows.length > 0 && initialFolders?.vaultId !== vaultId) {
    // Recorded once per vault, while rendering (React's "adjust state when
    // a value changes" pattern), so there's no effect and no extra frame.
    setInitialFolders({ vaultId, folders: collectFolderIds(rows) });
  }
  const defaultCollapsed = useMemo(
    () => savedCollapsed ?? (initialFolders?.vaultId === vaultId ? initialFolders.folders : new Set<string>()),
    [savedCollapsed, initialFolders, vaultId],
  );
  const collapsed =
    collapsedChoice && collapsedChoice.vaultId === vaultId ? collapsedChoice.folders : defaultCollapsed;

  const changeCollapsed = useCallback(
    (change: (folders: Set<string>) => Set<string> | null) => {
      if (!vaultId) return;
      setCollapsedChoice((prev) => {
        const current = prev && prev.vaultId === vaultId ? prev.folders : defaultCollapsed;
        const next = change(current);
        if (!next) return prev;
        saveCollapsed(vaultId, next);
        return { vaultId, folders: next };
      });
    },
    [defaultCollapsed, vaultId],
  );

  const toggleCollapsed = useCallback(
    (treeId: TreeID) =>
      changeCollapsed((current) => {
        const next = new Set(current);
        if (next.has(treeId)) next.delete(treeId);
        else next.add(treeId);
        return next;
      }),
    [changeCollapsed],
  );

  const expand = useCallback(
    (treeId: TreeID) =>
      changeCollapsed((current) => {
        if (!current.has(treeId)) return null;
        const next = new Set(current);
        next.delete(treeId);
        return next;
      }),
    [changeCollapsed],
  );

  const flat = useMemo(() => {
    const out: FlatEntry[] = [];
    flatten(rows, 0, undefined, collapsed, out);
    return out;
  }, [rows, collapsed]);

  const flatById = useMemo(() => {
    const map = new Map<string, FlatRow>();
    for (const f of flat) if (f.type === "row") map.set(f.row.treeId, f);
    return map;
  }, [flat]);

  const visibleDndRows = useMemo<VisibleDndRow[]>(
    () =>
      flat
        .filter((entry): entry is FlatRow => entry.type === "row")
        .map((entry) => ({
          treeId: entry.row.treeId,
          depth: entry.depth,
          parentTreeId: entry.parentTreeId,
          siblingIndex: entry.siblingIndex,
          kind: entry.row.kind,
        })),
    [flat],
  );

  const pick = (id: string) => {
    onSelect(id);
    closeMobileSidebar();
  };

  const pickAsset = (treeId: TreeID) => {
    onSelectAsset(treeId);
    closeMobileSidebar();
  };

  const {
    sensors,
    dndContextKey,
    activeDragId,
    draggedRow,
    placement,
    dragAnnouncement,
    sidebarContentRef,
    handleDragStart,
    handleDragOver,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
    handleKeyDownCapture,
  } = useSidebarDnd({ rows, flatById, visibleDndRows, collapsed, expand, onMove, isMobile, openMobile });


  const isEmpty = rows.length === 0;

  // Create actions no-op before the vault engine holds the writer lock
  // (VaultApp's creation handler guards on a missing engine/lock), so the buttons
  // that surface them stay disabled until writing is actually possible.
  const canWrite = Boolean(engine?.releaseWriterLock);
  const platform = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "mac" : "other";
  const enabledCollections = (Object.keys(COLLECTIONS) as LibraryCollection[]).filter((key) =>
    isCollectionEnabled(key, pluginFeatures),
  );

  return (
    <Sidebar variant="sidebar" className={cn("methyl-sidebar", activeDragId && "select-none touch-none")}>
      <SidebarHeader className="methyl-sidebar-header flex-row items-center justify-between gap-2 px-5 pt-6 md:pt-5">
        <div className="flex min-w-0 items-center gap-2">
          {/* A static decorative SVG: next/image would add nothing here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="size-6 shrink-0 rounded-md" />
          <h1 className="sr-only">Methyl</h1>
          <VaultSwitcher ready={Boolean(engine)} />
        </div>
        <div className="flex items-center gap-1">
          <CreateMenu
            onCreate={onCreate}
            onRequestNewFolder={() => requestNewFolder()}
            onRequestImport={onRequestImport}
            disabled={!canWrite}
            className="size-11 text-muted-foreground md:size-8"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="mobile-sidebar-close size-11 md:hidden"
            aria-label="Close sidebar"
            onClick={closeMobileSidebar}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent ref={sidebarContentRef}>
        <SidebarGroup>
          <Button
            variant="ghost"
            className="sidebar-search mb-4 h-11 w-full justify-start gap-2 px-3 font-normal text-muted-foreground md:h-9"
            onClick={onOpenCommandMenu}
          >
            <Search className="text-muted-foreground" />
            Search notes
            <Kbd className="ml-auto">{formatHotkey({ modifiers: ["Mod"], key: "K" }, platform)}</Kbd>
          </Button>
          {enabledCollections.length > 0 && (
            <nav aria-label="Collections" className="collection-nav">
              {enabledCollections.map((key) => {
                const { title, icon: Icon } = COLLECTIONS[key];
                return (
                  <button
                    key={key}
                    className="collection-link"
                    aria-current={collection === key ? "page" : undefined}
                    onClick={() => { onOpenCollection(key); closeMobileSidebar(); }}
                  >
                    <Icon aria-hidden="true" className={`collection-${key}`} />
                    <span>{title}</span>
                  </button>
                );
              })}
            </nav>
          )}
          <SidebarGroupLabel className="sidebar-section-label">
            Your notes
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {isEmpty ? (
              <Empty className="border-0 p-4">
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle className="text-sm">No notes yet</EmptyTitle>
              </Empty>
            ) : (
              <DndContext
                key={dndContextKey}
                sensors={sensors}
                collisionDetection={sidebarCollisionDetection}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              >
                <SidebarMenu
                  className="gap-0.5"
                  onKeyDownCapture={handleKeyDownCapture}
                >
                  {flat.map((f) =>
                    f.type === "empty" ? (
                      <EmptyFolderRow key={f.key} depth={f.depth} />
                    ) : f.type === "after" ? (
                      <FolderAfterDropZone
                        key={afterDropId(f.folderTreeId)}
                        folderTreeId={f.folderTreeId}
                        folderName={f.folderName}
                        depth={f.depth}
                        placement={placement}
                      />
                    ) : (
                      <Row
                        key={f.row.treeId}
                        flat={f}
                        activeId={activeId}
                        activeResourceKey={activeResourceKey}
                        isCollapsed={f.row.kind === "directory" && collapsed.has(f.row.treeId)}
                        onToggleCollapsed={toggleCollapsed}
                        onPick={pick}
                        onPickAsset={pickAsset}
                        placement={placement}
                        isDragging={activeDragId === f.row.treeId}
                        isDimmed={Boolean(
                          activeDragId &&
                            activeDragId !== f.row.treeId &&
                            findRow(
                              (draggedRow?.kind === "directory" ? draggedRow.children : []) ?? [],
                              f.row.treeId,
                            ),
                        )}
                        onCreate={onCreate}
                        onRequestNewFolder={requestNewFolder}
                        onRenameNoteRequest={setRenameTarget}
                        onDeleteNoteRequest={setDeleteTarget}
                        onRenameFolderRequest={setRenameFolderTarget}
                        onDeleteFolderRequest={setDeleteFolderTarget}
                        onRenameAssetRequest={setRenameAssetTarget}
                        onDeleteAssetRequest={setDeleteAssetTarget}
                      />
                    ),
                  )}
                </SidebarMenu>
                <DragOverlay>
                  <DragPreview
                    draggedRow={draggedRow}
                    placement={placement}
                    rows={rows}
                    activeDragId={activeDragId}
                  />
                </DragOverlay>
              </DndContext>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {dragAnnouncement}
      </div>

      <SidebarFooter className="methyl-sidebar-footer flex-row items-center justify-between gap-2">
        <PwaStatus engine={engine} />
      </SidebarFooter>

      {renameTarget && (
        <RenameNoteDialog
          open={Boolean(renameTarget)}
          onOpenChange={(open) => !open && setRenameTarget(null)}
          currentTitle={renameTarget.title}
          onRename={(title) => onRenameNote(renameTarget.id, title)}
        />
      )}
      {deleteTarget && (
        <DeleteNoteAlert
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          noteTitle={deleteTarget.title}
          onConfirm={() => onDeleteNote(deleteTarget.id)}
        />
      )}
      {renameFolderTarget && (
        <RenameFolderDialog
          open={Boolean(renameFolderTarget)}
          onOpenChange={(open) => !open && setRenameFolderTarget(null)}
          currentName={renameFolderTarget.name}
          onRename={(name) => onRenameFolder(renameFolderTarget.treeId, name)}
        />
      )}
      {deleteFolderTarget && (
        <DeleteFolderAlert
          open={Boolean(deleteFolderTarget)}
          onOpenChange={(open) => !open && setDeleteFolderTarget(null)}
          folderName={deleteFolderTarget.name}
          noteCount={countNotes(deleteFolderTarget)}
          onConfirm={() => onDeleteFolder(deleteFolderTarget.treeId)}
        />
      )}
      {renameAssetTarget && (
        <RenameAssetDialog
          open={Boolean(renameAssetTarget)}
          onOpenChange={(open) => !open && setRenameAssetTarget(null)}
          currentName={renameAssetTarget.title}
          onRename={(name) => onRenameAsset(renameAssetTarget.treeId, name)}
        />
      )}
      {deleteAssetTarget && (
        <DeleteAssetAlert
          open={Boolean(deleteAssetTarget)}
          onOpenChange={(open) => !open && setDeleteAssetTarget(null)}
          assetName={deleteAssetTarget.title}
          onConfirm={() => onDeleteAsset(deleteAssetTarget.treeId)}
        />
      )}
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={onNewFolderOpenChange}
        onCreate={(name) => onCreate({ kind: "folder", parentTreeId: newFolderParent, name })}
      />
    </Sidebar>
  );
}
