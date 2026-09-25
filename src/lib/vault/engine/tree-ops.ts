import type { TreeID } from "loro-crdt";
import type { VaultEngine } from "@/lib/vault/engine";
import {
  buildPathFromNode,
  collectBinaryNodes,
  collectDocumentIds,
  isDescendant,
} from "@/lib/vault/engine/helpers";

/** Tree operations that move files on disk: rename, move and delete notes and folders. */

/**
 * Rename a note: renames the tree node's file name only. Content is
 * never touched — the title shown in the UI (sidebar/palette/breadcrumb)
 * comes from the tree node's name, not from frontmatter or an `# H1`, so
 * renaming can't make a note "disappear" by orphaning it from whatever
 * heading used to identify it. A case-insensitive clash with a sibling
 * is auto-suffixed by VaultTree.rename rather than rejected.
 */
export async function renameDocument(
  engine: VaultEngine,
  documentId: string,
  newTitle: string,
): Promise<void> {
  // Moves and removes files of every document it touches.
  await engine.allDocumentsLoaded;
  const node = engine.tree.findByDocumentId(documentId);
  if (!node) throw new Error(`Document not tracked in tree: ${documentId}`);
  const fileName = newTitle.endsWith(".md") ? newTitle : `${newTitle}.md`;
  engine.tree.rename(node.treeId, fileName);
  await engine.materializeToTreePath(documentId);
}

/**
 * Delete a note: removes it from the vault tree (source of truth for
 * which documents are active) and drops the in-memory Document so the
 * editor can no longer touch it. The persisted CRDT directory is left in
 * place — recovery (`VaultEngine.open`) already reports it as an
 * `orphanedDocs` entry rather than resurrecting it, which is where
 * eventual GC of on-disk state belongs (§42); deleting bytes here would
 * race a concurrent sync peer that hasn't seen the tree deletion yet.
 */
export async function deleteDocument(engine: VaultEngine, documentId: string): Promise<void> {
  // Moves and removes files of every document it touches.
  await engine.allDocumentsLoaded;
  const node = engine.tree.findByDocumentId(documentId);
  if (!node) throw new Error(`Document not tracked in tree: ${documentId}`);
  const oldPath = engine.materializedPaths.get(documentId) ?? buildPathFromNode(engine.tree, node);
  engine.tree.delete(node.treeId);
  engine.documents.delete(documentId);
  engine.materializedPaths.delete(documentId);
  await engine.persistTree();
  if (oldPath) {
    await engine.materializedRemove(oldPath);
    await engine.dropIndexEntry(oldPath);
  }
  await engine.updateIndexesForDocument(documentId);
  await engine.diag("delete-document", { detail: `${documentId} ${oldPath ?? ""}`.trim() });
}

/**
 * After a tree change merged in from sync, make materialized paths follow
 * the tree: remove files of deleted notes, move renamed notes, and prune
 * empty deleted directories. Uningested external edits stay untouched.
 */
export function listDirectoryPaths(engine: VaultEngine): string[] {
  return engine.tree.allNodes()
    .filter((node) => node.kind === "directory")
    .map((node) => buildPathFromNode(engine.tree, node))
    .filter((path): path is string => path !== null);
}

export async function applyTreeToDisk(
  engine: VaultEngine,
  previousDirectoryPaths: readonly string[] = [],
): Promise<{ removed: string[]; moved: string[] }> {
  await engine.allDocumentsLoaded;
  const removed: string[] = [];
  const moved: string[] = [];
  const live = new Set(engine.tree.documentIds());
  for (const [documentId, path] of [...engine.materializedPaths]) {
    if (live.has(documentId)) continue;
    if (await engine.externalEditPendingAt(path)) {
      await engine.deferWriteForExternalEdit(documentId, path);
      continue;
    }
    await engine.materializedRemove(path);
    await engine.dropIndexEntry(path);
    engine.materializedPaths.delete(documentId);
    engine.documents.delete(documentId);
    await engine.updateIndexesForDocument(documentId);
    removed.push(path);
  }
  for (const documentId of live) {
    if (!engine.documents.has(documentId)) continue;
    const node = engine.tree.findByDocumentId(documentId);
    const path = node ? buildPathFromNode(engine.tree, node): null;
    const current = engine.materializedPaths.get(documentId);
    if (!path || !current || current === path) continue;
    if (await engine.materializeToTreePath(documentId)) moved.push(path);
  }
  const currentDirectories = new Set(listDirectoryPaths(engine));
  for (const path of new Set(previousDirectoryPaths)) {
    if (!currentDirectories.has(path)) {
      await engine.docStore.removeEmptyMaterializedDirectories(path);
    }
  }
  if (removed.length > 0 || moved.length > 0) {
    await engine.diag("apply-tree-to-disk", {
      counts: { removed: removed.length, moved: moved.length },
      detail: [...removed, ...moved].slice(0, 10).join(","),
    });
  }
  return { removed, moved };
}

/**
 * Move a tree node (note or folder) to a new parent at an optional index.
 * Refuses to drop a folder into itself or one of its own descendants.
 * Does not persist — call persistTreeIncremental after.
 *
 * Note: this only updates the CRDT tree; it does not itself rewrite any
 * on-disk materialised path. The next materializeDocument/materializeAll
 * call recomputes the path from the tree, so the move is picked up lazily
 * rather than eagerly re-materialising here.
 */
export async function moveNode(
  engine: VaultEngine,
  treeId: TreeID,
  newParentTreeId: TreeID | undefined,
  index?: number,
): Promise<void> {
  await engine.allDocumentsLoaded;
  if (newParentTreeId && isDescendant(engine.tree, newParentTreeId, treeId)) {
    throw new Error("Cannot move a folder into its own descendant");
  }
  if (newParentTreeId === treeId) {
    throw new Error("Cannot move a node into itself");
  }
  engine.tree.move(treeId, newParentTreeId, index);
  await engine.rematerializeSubtree(treeId);
}

/**
 * Rename a folder node (directory kind, not a document). Does not
 * persist the tree — call persistTreeIncremental after. Every document
 * beneath the folder gets its path re-derived and its `.md` moved, since
 * the folder rename changes all of their paths too.
 */
export async function renameFolder(engine: VaultEngine, treeId: TreeID, newName: string): Promise<void> {
  // Moves and removes files of every document it touches.
  await engine.allDocumentsLoaded;
  engine.tree.rename(treeId, newName);
  await engine.rematerializeSubtree(treeId);
}

/** Re-write the `.md` mirror (old path -> new path) for a note or every note under a folder. */
export async function rematerializeSubtree(engine: VaultEngine, treeId: TreeID): Promise<void> {
  const node = engine.tree.getNode(treeId);
  if (!node) return;
  if (node.kind === "binary") {
    await engine.rematerializeAsset(node.treeId, node);
    return;
  }
  if (node.kind === "markdown" && node.documentId) {
    await engine.materializeToTreePath(node.documentId);
    return;
  }
  if (node.kind === "directory") {
    for (const docId of collectDocumentIds(engine.tree, treeId)) {
      await engine.materializeToTreePath(docId);
    }
    for (const asset of collectBinaryNodes(engine.tree, treeId)) {
      await engine.rematerializeAsset(asset.treeId, asset);
    }
  }
}

/**
 * Delete a folder and everything beneath it. Removes any contained
 * documents from the in-memory map as well as the tree (mirrors
 * deleteDocument's semantics: persisted CRDT bytes are left in place for
 * recovery/GC, only the tree pointer is removed).
 */
export async function deleteFolder(engine: VaultEngine, treeId: TreeID): Promise<void> {
  // Moves and removes files of every document it touches.
  await engine.allDocumentsLoaded;
  const node = engine.tree.getNode(treeId);
  if (!node) throw new Error(`Node not found: ${treeId}`);
  const folderPath = buildPathFromNode(engine.tree, node);
  const docIds = collectDocumentIds(engine.tree, treeId);
  const assetNodes = collectBinaryNodes(engine.tree, treeId);
  const oldPaths: string[] = [];
  for (const docId of docIds) {
    const path = engine.materializedPaths.get(docId);
    if (path) oldPaths.push(path);
    engine.documents.delete(docId);
    engine.materializedPaths.delete(docId);
  }
  const oldAssetPaths = assetNodes
    .map((asset) => engine.materializedAssetPaths.get(String(asset.treeId)) ?? buildPathFromNode(engine.tree, asset))
    .filter((path): path is string => path !== null);
  for (const asset of assetNodes) engine.materializedAssetPaths.delete(String(asset.treeId));
  engine.tree.delete(treeId);
  await engine.persistTree();
  for (const path of oldPaths) {
    await engine.materializedRemove(path);
    await engine.dropIndexEntry(path);
  }
  for (const path of oldAssetPaths) await engine.materializedRemove(path);
  if (folderPath) await engine.docStore.removeEmptyMaterializedDirectories(folderPath);
  await engine.refreshIndexes();
  await engine.diag("delete-folder", {
    counts: { docs: docIds.length, assets: assetNodes.length },
    detail: `${treeId} ${oldPaths.slice(0, 10).join(",")}`,
  });
}
