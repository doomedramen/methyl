"use client";

import { useCallback } from "react";
import type { TreeID } from "loro-crdt";
import { toast } from "sonner";
import type { VaultEngine } from "@/lib/vault/engine";
import type { WorkspaceStore } from "@/lib/workspace/store";
import type { SidebarRow } from "./AppSidebar";
import { findFolder, flattenNotes } from "./vault-rows";

/**
 * Rename, delete and move notes, folders and attachments from the sidebar:
 * each checks the writer lock, updates the tree and files, and refreshes the
 * sidebar; deleting what's open closes it.
 */
export function useTreeActions({
  engine,
  requireWriter,
  refreshNotes,
  pruneWorkspace,
  activeId,
  workspaceStore,
  rows,
}: {
  engine: VaultEngine | null;
  requireWriter: () => boolean;
  refreshNotes: (engine: VaultEngine) => void;
  pruneWorkspace: (engine: VaultEngine) => void;
  activeId: string | null;
  workspaceStore: WorkspaceStore | null;
  rows: SidebarRow[];
}) {
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

  return { onRenameNote, onDeleteNote, onRenameFolder, onDeleteFolder, onRenameAsset, onDeleteAsset, onMove };
}
