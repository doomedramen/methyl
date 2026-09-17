import { LoroDoc, type OpId, type TreeID } from "loro-crdt";
import { VaultTree, type VaultTreeNode } from "@/lib/vault/tree";
import { Document, CONTENT_KEY } from "@/lib/core/document";
import type { PersistedDocStore, VaultTreeStore } from "@/lib/vault/store";
import type {
  DirtyRoom,
  MaterializationCheckpoint,
  PersistedDocState,
} from "@/lib/core/types";
import { sha256Text } from "@/lib/core/hash";
import {
  shouldCompact,
  DEFAULT_COMPACTION_RULES,
  type CompactionRules,
} from "@/lib/vault/compact";

/**
 * Recovery result from VaultEngine.open().
 * Structured so the caller can surface repair status to the UI (§42).
 */
export interface VaultRecoveryReport {
  activeIds: string[];
  persistedIds: string[];
  missingDocs: string[];
  orphanedDocs: string[];
  /**
   * Documents whose LoroText still carried a legacy `<!-- adhd:id=... -->`
   * comment (pre-sidecar-index vaults) and were migrated in place on this
   * open — the comment was deleted as a normal CRDT edit. These no longer
   * match their on-disk `.md` hash, so callers should re-materialise them
   * (e.g. via repairDocument) to write the now-clean file.
   */
  migratedLegacyIds: string[];
}

export class VaultEngine {
  readonly tree: VaultTree;
  readonly treeStore: VaultTreeStore;
  readonly docStore: PersistedDocStore;
  readonly vaultId: string;
  /** Optional writer-lock release, wired by the browser host (§12). */
  releaseWriterLock?: () => void;
  private documents = new Map<string, Document>();
  /**
   * Last path each doc was materialised at, tracked in memory so a
   * subsequent rename/move can delete the stale file instead of leaving it
   * behind. Derived at boot (assumed = current tree path; reconcile()
   * corrects anything that turns out to be wrong) and kept current by every
   * materialize/rename/move/delete call.
   */
  private materializedPaths = new Map<string, string>();

  private constructor(
    tree: VaultTree,
    treeStore: VaultTreeStore,
    docStore: PersistedDocStore,
    vaultId: string,
  ) {
    this.tree = tree;
    this.treeStore = treeStore;
    this.docStore = docStore;
    this.vaultId = vaultId;
  }

  /** Create a fresh vault (P0.1 path). */
  static async create(
    treeStore: VaultTreeStore,
    docStore: PersistedDocStore,
    vaultId = "local",
  ): Promise<VaultEngine> {
    const tree = VaultTree.create();
    const engine = new VaultEngine(tree, treeStore, docStore, vaultId);
    await engine.persistTree();
    return engine;
  }

  /**
   * Open an existing vault following §42 boot order:
   *   1. Load vault-tree CRDT  (never scans directories — the tree IS truth)
   *   2. Derive active document IDs from tree
   *   3. Load only those documents
   *   4. Compare persisted list against tree list → recovery report
   *   5. (materialisation repair is handled by caller / migrate function)
   */
  static async open(
    treeStore: VaultTreeStore,
    docStore: PersistedDocStore,
    vaultId = "local",
  ): Promise<{ engine: VaultEngine; recovery: VaultRecoveryReport }> {
    // 1. Load vault-tree CRDT: snapshot + replay updates
    const treeSnap = await treeStore.loadSnapshot();
    const tree = new VaultTree();
    if (treeSnap) {
      tree.doc.import(treeSnap);
    }
    for (const update of await treeStore.loadUpdates()) {
      tree.doc.import(update);
    }
    tree.doc.commit();

    const engine = new VaultEngine(tree, treeStore, docStore, vaultId);

    // 2. Active document IDs from tree (source of truth)
    const activeIds = tree.documentIds();

    // 3. Load only active documents
    const migratedLegacyIds: string[] = [];
    for (const id of activeIds) {
      const doc = new Document(id);
      const snapshot = await docStore.loadSnapshot(id);
      if (snapshot) {
        doc.doc.import(snapshot);
      }
      for (const update of await docStore.loadUpdates(id)) {
        doc.doc.import(update);
      }
      doc.doc.commit();

      // One-time migration: strip any legacy `adhd:id` comment still
      // living in previously-persisted LoroText (see
      // Document.migrateLegacyIdComment). This is a real CRDT edit, so
      // persist it immediately so it survives and syncs.
      if (doc.migrateLegacyIdComment()) {
        migratedLegacyIds.push(id);
        await docStore.appendUpdate(id, doc.doc.export({ mode: "update" }));
      }

      engine.documents.set(id, doc);

      // Derive the assumed on-disk path from the tree; reconcileMaterialization()
      // verifies this against reality (missing/stale files, orphaned paths).
      const node = tree.findByDocumentId(id);
      const assumedPath = node && buildPathFromNode(tree, node);
      if (assumedPath) engine.materializedPaths.set(id, assumedPath);
    }

    // 4. Recovery diff — does NOT resurrect deleted docs
    const persistedIds = await docStore.listDocumentIds();
    const activeSet = new Set(activeIds);
    const persistedSet = new Set(persistedIds);

    const recovery: VaultRecoveryReport = {
      activeIds,
      persistedIds,
      missingDocs: activeIds.filter((id) => !persistedSet.has(id)),
      orphanedDocs: persistedIds.filter((id) => !activeSet.has(id)),
      migratedLegacyIds,
    };

    return { engine, recovery };
  }

  getDocument(id: string): Document | undefined {
    return this.documents.get(id);
  }

  listDocuments(): Document[] {
    return Array.from(this.documents.values());
  }

  /**
   * Create a new Markdown note in the vault tree. The document ID is either
   * recovered from a legacy `<!-- adhd:id=... -->` comment (migration path
   * for files predating the sidecar doc index — the comment is stripped,
   * never persisted) or freshly generated; identity lives in the vault tree,
   * not in file content.
   */
  createDocument(
    parentTreeId: TreeID | undefined,
    name: string,
    markdown: string,
  ): Document {
    const docId = Document.extractLegacyId(markdown) ?? crypto.randomUUID();
    const doc = Document.fromMarkdown(docId, markdown);
    this.tree.addMarkdownDocument(parentTreeId, name, docId);
    this.documents.set(docId, doc);
    return doc;
  }

  /**
   * Materialise one document to disk (§11):
   *   - compute hash of the Markdown content
   *   - write .md atomically via tmp → rename
   *   - persist the CRDT snapshot atomically via compact()
   *   - store materialisation checkpoint (sha256 + Loro frontiers)
   */
  async materializeDocument(
    documentId: string,
    filePath: string,
  ): Promise<MaterializationCheckpoint | null> {
    const doc = this.documents.get(documentId);
    if (!doc) return null;

    doc.doc.commit();
    const markdown = doc.getText(CONTENT_KEY).toString();
    const frontiers = doc.doc.oplogFrontiers();
    const hash = await sha256Text(markdown);

    // 1. Write materialised .md atomically (UTF-8 only here)
    const mdBytes = new TextEncoder().encode(markdown);
    await this.docStore.writeMaterializedAtomic(filePath, mdBytes);

    // 2. Persist CRDT state atomically via compact()
    const now = Date.now();
    const snapBytes = doc.doc.export({ mode: "snapshot" });
    const checkpoint: MaterializationCheckpoint = {
      documentId,
      frontiers,
      sha256: hash,
    };
    const persistedState: PersistedDocState = {
      documentId,
      frontiers,
      sha256: hash,
      compactedAt: now,
      lastUpdateAt: now,
      segments: 0,
      updateBytes: 0,
    };
    await this.docStore.compact(documentId, snapBytes, persistedState);
    this.materializedPaths.set(documentId, filePath);

    return checkpoint;
  }

  /**
   * Materialise all tree-tracked documents. Used on first boot and repair.
   * Returns a recovery report so callers know what changed.
   */
  async materializeAll(
    rootPath: string,
  ): Promise<Map<string, MaterializationCheckpoint>> {
    const checkpoints = new Map<string, MaterializationCheckpoint>();
    for (const node of this.tree.allNodes()) {
      if (node.kind !== "markdown" || !node.documentId) continue;
      const filePath = buildPathFromNode(this.tree, node);
      if (!filePath) continue;
      const cp = await this.materializeDocument(
        node.documentId,
        `${rootPath}/${filePath}`,
      );
      if (cp) checkpoints.set(node.documentId, cp);
    }
    return checkpoints;
  }

  /** Materialise specific documents at their current tree path. */
  async materializeDocuments(documentIds: Iterable<string>): Promise<void> {
    for (const id of documentIds) {
      const node = this.tree.findByDocumentId(id);
      const filePath = node && buildPathFromNode(this.tree, node);
      if (filePath) await this.materializeDocument(id, filePath);
    }
  }

  /**
   * Write a document's current content to its current tree path, and
   * remove the file at its *previous* materialised path (tracked in
   * `materializedPaths`) if that path changed — e.g. after a rename or a
   * move into a different folder. No-op if the doc isn't tree-tracked.
   */
  private async materializeToTreePath(documentId: string): Promise<void> {
    const node = this.tree.findByDocumentId(documentId);
    const doc = this.documents.get(documentId);
    if (!node || !doc) return;
    const newPath = buildPathFromNode(this.tree, node);
    if (!newPath) return;
    const oldPath = this.materializedPaths.get(documentId);
    doc.doc.commit();
    const bytes = new TextEncoder().encode(doc.getText(CONTENT_KEY).toString());
    await this.docStore.writeMaterializedAtomic(newPath, bytes);
    if (oldPath && oldPath !== newPath) {
      await this.docStore.removeMaterialized(oldPath);
    }
    this.materializedPaths.set(documentId, newPath);
  }

  /**
   * Boot-time (and on-demand) reconciliation so the on-disk `.md` tree
   * always mirrors the CRDT tree + content:
   *   - re-materialise any tracked doc whose file is missing or stale
   *   - delete any materialised `.md` that no longer corresponds to a tree
   *     node (stale path left behind by a rename/move that happened before
   *     this session, e.g. across a crash) — never touches `.adhd`
   */
  async reconcileMaterialization(): Promise<{ materialized: string[]; removed: string[] }> {
    const materialized: string[] = [];
    const expected = new Set<string>();
    for (const node of this.tree.allNodes()) {
      const path = buildPathFromNode(this.tree, node);
      if (!path) continue;
      if (node.kind === "binary") {
        // Not materialised by this engine (yet) — just protect it from GC.
        expected.add(path);
        continue;
      }
      if (node.kind !== "markdown" || !node.documentId) continue;
      if (!this.documents.has(node.documentId)) continue;
      expected.add(path);
      if (await this.isStale(node.documentId, path)) {
        const cp = await this.materializeDocument(node.documentId, path);
        if (cp) materialized.push(path);
      } else {
        this.materializedPaths.set(node.documentId, path);
      }
    }

    const removed: string[] = [];
    for (const path of await this.docStore.listMaterializedPaths()) {
      if (path.endsWith(".tmp")) continue;
      if (!expected.has(path)) {
        await this.docStore.removeMaterialized(path);
        removed.push(path);
      }
    }
    return { materialized, removed };
  }

  /** Check if a materialised file is stale compared to the CRDT document. */
  async isStale(
    documentId: string,
    filePath: string,
  ): Promise<boolean> {
    const doc = this.documents.get(documentId);
    if (!doc) return false;
    const mdBytes = await this.docStore.readMaterialized(filePath);
    if (!mdBytes) return true;
    const currentHash = await sha256Text(new TextDecoder().decode(mdBytes));
    doc.doc.commit();
    const hash = await sha256Text(doc.getText(CONTENT_KEY).toString());
    return currentHash !== hash;
  }

  /**
   * Repair: rewrite a stale or missing materialised file for one document.
   * Returns the new checkpoint if it wrote, null if nothing changed.
   */
  async repairDocument(
    documentId: string,
    filePath: string,
  ): Promise<MaterializationCheckpoint | null> {
    const doc = this.documents.get(documentId);
    if (!doc) return null;
    const mdBytes = new TextEncoder().encode(doc.getText(CONTENT_KEY).toString());
    await this.docStore.writeMaterializedAtomic(filePath, mdBytes);
    const frontiers = doc.doc.oplogFrontiers();
    const hash = await sha256Text(doc.getText(CONTENT_KEY).toString());
    const now = Date.now();
    const checkpoint: MaterializationCheckpoint = { documentId, frontiers, sha256: hash };
    await this.docStore.compact(
      documentId,
      doc.doc.export({ mode: "snapshot" }),
      {
        documentId,
        frontiers,
        sha256: hash,
        compactedAt: now,
        lastUpdateAt: now,
        segments: 0,
        updateBytes: 0,
      },
    );
    return checkpoint;
  }

  /** Import a document update (from sync or external source). */
  async importDocumentUpdate(documentId: string, data: Uint8Array): Promise<void> {
    const doc = this.documents.get(documentId);
    if (doc) doc.doc.import(data);
  }

  /**
   * Persist a new commit as an incremental update segment; compact when
   * thresholds are breached (§10). Returns whether compaction ran.
   * Call this after every local edit-commit; never touch binary bytes yourself.
   */
  async persistDocumentIncremental(
    documentId: string,
    rules: CompactionRules = DEFAULT_COMPACTION_RULES,
  ): Promise<{ compacted: boolean }> {
    const doc = this.documents.get(documentId);
    if (!doc) throw new Error(`Document not found: ${documentId}`);
    doc.doc.commit();
    const update = doc.doc.export({ mode: "update" });
    await this.docStore.appendUpdate(documentId, update);

    // Keep the on-disk .md mirror current. The editor already debounces
    // calls into this method (session flush), so this isn't per-keystroke.
    await this.materializeToTreePath(documentId);

    const state = await this.docStore.readState(documentId);
    if (!state) return { compacted: false };

    const now = Date.now();
    if (!shouldCompact(state, now, rules)) return { compacted: false };

    doc.doc.commit();
    const snapshot = doc.doc.export({ mode: "snapshot" });
    await this.docStore.compact(documentId, snapshot, {
      documentId,
      frontiers: doc.doc.oplogFrontiers(),
      sha256: state.sha256,
      compactedAt: now,
      lastUpdateAt: now,
      segments: 0,
      updateBytes: 0,
    });
    return { compacted: true };
  }

  /** Incremental persist the vault-tree CRDT with compaction. */
  async persistTreeIncremental(
    rules: CompactionRules = DEFAULT_COMPACTION_RULES,
  ): Promise<{ compacted: boolean }> {
    this.tree.doc.commit();
    const update = this.tree.doc.export({ mode: "update" });
    await this.treeStore.appendUpdate(update);

    const state = await this.treeStore.readState();
    if (!state) return { compacted: false };

    const now = Date.now();
    if (!shouldCompact(state, now, rules)) return { compacted: false };

    this.tree.doc.commit();
    const snapshot = this.tree.doc.export({ mode: "snapshot" });
    await this.treeStore.compact(snapshot, {
      frontiers: this.tree.doc.oplogFrontiers(),
      compactedAt: now,
      lastUpdateAt: now,
      segments: 0,
      updateBytes: 0,
    });
    return { compacted: true };
  }

  /** Persist the vault tree via compact() (separate from doc persistence). */
  async persistTree(): Promise<void> {
    this.tree.doc.commit();
    const snapshot = this.tree.doc.export({ mode: "snapshot" });
    const frontiers = this.tree.doc.oplogFrontiers();
    const now = Date.now();
    await this.treeStore.compact(snapshot, {
      frontiers,
      compactedAt: now,
      lastUpdateAt: now,
      segments: 0,
      updateBytes: 0,
    });
  }

  /**
   * Rename a note: renames the tree node's file name only. Content is
   * never touched — the title shown in the UI (sidebar/palette/breadcrumb)
   * comes from the tree node's name, not from frontmatter or an `# H1`, so
   * renaming can't make a note "disappear" by orphaning it from whatever
   * heading used to identify it. A case-insensitive clash with a sibling
   * is auto-suffixed by VaultTree.rename rather than rejected.
   */
  async renameDocument(documentId: string, newTitle: string): Promise<void> {
    const node = this.tree.findByDocumentId(documentId);
    if (!node) throw new Error(`Document not tracked in tree: ${documentId}`);
    const fileName = newTitle.endsWith(".md") ? newTitle : `${newTitle}.md`;
    this.tree.rename(node.treeId, fileName);
    await this.materializeToTreePath(documentId);
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
  async deleteDocument(documentId: string): Promise<void> {
    const node = this.tree.findByDocumentId(documentId);
    if (!node) throw new Error(`Document not tracked in tree: ${documentId}`);
    const oldPath = this.materializedPaths.get(documentId) ?? buildPathFromNode(this.tree, node);
    this.tree.delete(node.treeId);
    this.documents.delete(documentId);
    this.materializedPaths.delete(documentId);
    await this.persistTree();
    if (oldPath) await this.docStore.removeMaterialized(oldPath);
  }

  /** Record a dirty room for tracking sync status. */
  async markDirty(documentId: string): Promise<DirtyRoom> {
    const doc = this.documents.get(documentId);
    if (!doc) throw new Error(`Document not found: ${documentId}`);
    return { roomId: `doc:${documentId}`, targetFrontiers: doc.frontiers() };
  }

  /**
   * Create a new folder (directory) node in the vault tree. Like
   * createDocument, does not persist — call persistTreeIncremental after.
   */
  createFolder(parentTreeId: TreeID | undefined, name: string): TreeID {
    return this.tree.addDirectory(parentTreeId, name);
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
  async moveNode(
    treeId: TreeID,
    newParentTreeId: TreeID | undefined,
    index?: number,
  ): Promise<void> {
    if (newParentTreeId && isDescendant(this.tree, newParentTreeId, treeId)) {
      throw new Error("Cannot move a folder into its own descendant");
    }
    if (newParentTreeId === treeId) {
      throw new Error("Cannot move a node into itself");
    }
    this.tree.move(treeId, newParentTreeId, index);
    await this.rematerializeSubtree(treeId);
  }

  /**
   * Rename a folder node (directory kind, not a document). Does not
   * persist the tree — call persistTreeIncremental after. Every document
   * beneath the folder gets its path re-derived and its `.md` moved, since
   * the folder rename changes all of their paths too.
   */
  async renameFolder(treeId: TreeID, newName: string): Promise<void> {
    this.tree.rename(treeId, newName);
    await this.rematerializeSubtree(treeId);
  }

  /** Re-write the `.md` mirror (old path -> new path) for a note or every note under a folder. */
  private async rematerializeSubtree(treeId: TreeID): Promise<void> {
    const node = this.tree.getNode(treeId);
    if (!node) return;
    if (node.kind === "markdown" && node.documentId) {
      await this.materializeToTreePath(node.documentId);
      return;
    }
    if (node.kind === "directory") {
      for (const docId of collectDocumentIds(this.tree, treeId)) {
        await this.materializeToTreePath(docId);
      }
    }
  }

  /**
   * Delete a folder and everything beneath it. Removes any contained
   * documents from the in-memory map as well as the tree (mirrors
   * deleteDocument's semantics: persisted CRDT bytes are left in place for
   * recovery/GC, only the tree pointer is removed).
   */
  async deleteFolder(treeId: TreeID): Promise<void> {
    const node = this.tree.getNode(treeId);
    if (!node) throw new Error(`Node not found: ${treeId}`);
    const docIds = collectDocumentIds(this.tree, treeId);
    const oldPaths: string[] = [];
    for (const docId of docIds) {
      const path = this.materializedPaths.get(docId);
      if (path) oldPaths.push(path);
      this.documents.delete(docId);
      this.materializedPaths.delete(docId);
    }
    this.tree.delete(treeId);
    await this.persistTree();
    for (const path of oldPaths) await this.docStore.removeMaterialized(path);
  }
}

/** True if `candidate` is `ancestorId` itself or a descendant of it. */
function isDescendant(
  tree: VaultTree,
  candidate: TreeID,
  ancestorId: TreeID,
): boolean {
  let current = tree.tree.getNodeByID(candidate);
  while (current) {
    if (current.id === ancestorId) return true;
    current = current.parent() ?? undefined;
  }
  return false;
}

/** All markdown document IDs contained within a subtree (inclusive). */
function collectDocumentIds(tree: VaultTree, rootTreeId: TreeID): string[] {
  const ids: string[] = [];
  const visit = (treeId: TreeID) => {
    const node = tree.getNode(treeId);
    if (node?.kind === "markdown" && node.documentId) ids.push(node.documentId);
    for (const child of tree.children(treeId)) visit(child.treeId);
  };
  visit(rootTreeId);
  return ids;
}

function buildPathFromNode(
  tree: VaultTree,
  node: VaultTreeNode,
): string | null {
  const parts: string[] = [];
  let current = tree.tree.getNodeByID(node.treeId);
  while (current) {
    const name = (current.data.get("name") as string) || "";
    parts.unshift(name);
    const parent = current.parent();
    current = parent ?? undefined;
  }
  return parts.join("/");
}