import type { OpId, TreeID } from "loro-crdt";
import { markBoot } from "@/lib/core/boot-marks";
import type { DocIndex } from "@/lib/core/doc-index";
import { Document } from "@/lib/core/document";
import { isMetaDirName, META_DIR } from "@/lib/core/paths";
import type { DirtyRoom, DocIndexEntry, MaterializationCheckpoint } from "@/lib/core/types";
import {
  type BacklinkEntry,
  DerivedIndexes,
  type IndexedDocument,
  SearchIndex,
  searchIndexStorageFromDocStore,
} from "@/lib/search/index";
import { type CompactionRules, DEFAULT_COMPACTION_RULES } from "@/lib/vault/compact";
import { recordDiagnostic } from "@/lib/vault/diagnostics";
import {
  buildPathFromNode,
  DOC_INDEX_PATH,
  DOC_LOAD_CONCURRENCY,
  mapConcurrent,
} from "@/lib/vault/engine/helpers";
import type {
  AssetIngestReport,
  IngestReport,
  VaultRecoveryReport,
} from "@/lib/vault/engine/types";
import type { PersistedDocStore, VaultTreeStore } from "@/lib/vault/store";
import { VaultTree, type VaultTreeNode } from "@/lib/vault/tree";
import * as attachments from "@/lib/vault/engine/attachments";
import * as docIndex from "@/lib/vault/engine/doc-index";
import * as indexes from "@/lib/vault/engine/indexes";
import * as ingest from "@/lib/vault/engine/ingest";
import * as materialize from "@/lib/vault/engine/materialize";
import * as persist from "@/lib/vault/engine/persist";
import * as treeOps from "@/lib/vault/engine/tree-ops";

export { ATTACHMENTS_FOLDER_NAME, buildPathFromNode, isIgnoredExternalPath } from "@/lib/vault/engine/helpers";
export type { AssetIngestReport, IngestReport, VaultRecoveryReport } from "@/lib/vault/engine/types";

/**
 * The vault engine: one vault's tree, documents and their files on disk.
 *
 * This file holds the engine's state, opening and loading, and its public
 * API. The work lives in engine/: indexes, attachments, materialize (Markdown
 * writes), doc-index, ingest (external changes), persist and tree-ops. Their
 * functions take the engine as their first argument, which is why members
 * those modules share aren't `private`: treat anything marked @internal as
 * private to src/lib/vault/engine*.
 */
export class VaultEngine {
  readonly tree: VaultTree;
  readonly treeStore: VaultTreeStore;
  readonly docStore: PersistedDocStore;
  readonly vaultId: string;
  /** Optional writer-lock release, wired by the browser host (§12). */
  releaseWriterLock?: () => void;
  documents = new Map<string, Document>();
  documentAvailableListeners = new Map<string, Set<() => void>>();
  /**
   * Last path each doc was materialised at, tracked in memory so a
   * subsequent rename/move can delete the stale file instead of leaving it
   * behind. Derived at boot (assumed = current tree path; reconcile()
   * corrects anything that turns out to be wrong) and kept current by every
   * materialize/rename/move/delete call.
   */
  materializedPaths = new Map<string, string>();
  /** Index paths written while an ingest pass applies its results. */
  indexTouchesThisPass: Set<string> | null = null;
  /** In-memory doc index; see loadDocIndex. */
  docIndexCache: DocIndex | null = null;
  docIndexWriteChain: Promise<void> = Promise.resolve();
  docIndexWriteQueued: Promise<void> | null = null;
  deferDocIndexWrites = false;
  /** Pending debounced write of the derived search/backlink/graph caches. */
  indexPersistTimer: ReturnType<typeof setTimeout> | null = null;
  indexPersistWaiters: Array<() => void> = [];
  materializedAssetPaths = new Map<string, string>();
  readonly searchIndex: SearchIndex;
  readonly derivedIndexes: DerivedIndexes;
  searchIndexReady = false;
  indexPersistChain: Promise<void> = Promise.resolve();

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
    const indexStorage = searchIndexStorageFromDocStore(docStore);
    this.searchIndex = new SearchIndex(indexStorage);
    this.derivedIndexes = new DerivedIndexes(indexStorage);
  }

  /**
   * Defense in depth (confirmed real-world cause of a vault wipe): every
   * `.md` materialise/remove call must funnel through here rather than
   * calling `docStore.writeMaterializedAtomic`/`removeMaterialized`
   * directly. `.methyl/` is reserved for the app's own CRDT storage/index;
   * `sanitizeName` now blocks a tree node from being named `.methyl`, but
   * this is a second, independent check — a materialised path must never
   * touch that directory regardless of how it was computed, since OPFS's
   * `delete()` is recursive and a single wrong call there can destroy the
   * entire CRDT store in one shot. `DOC_INDEX_PATH` itself is the one
   * legitimate exception (it's the sidecar index file, deliberately
   * co-located with `.methyl/` so `listMaterializedPaths()` never lists it).
   */
  isPathUnderReservedDir(path: string): boolean {
    if (path === DOC_INDEX_PATH) return false;
    const top = path.split("/")[0]!;
    return isMetaDirName(top);
  }

  /** Best-effort diagnostics append — never throws, never blocks the caller. */
  async diag(op: string, options?: { counts?: Record<string, number>; detail?: string }): Promise<void> {
    await recordDiagnostic(this.docStore, op, options);
  }

  async materializedWrite(path: string, bytes: Uint8Array): Promise<void> {
    if (this.isPathUnderReservedDir(path)) {
      console.error(
        `[VaultEngine] refusing to write materialised path "${path}" — ` +
          `it falls under the reserved ${META_DIR}/ metadata directory.`,
      );
      await this.diag("refuse-reserved-path-write", { detail: path });
      return;
    }
    await this.docStore.writeMaterializedAtomic(path, bytes);
  }

  async materializedRemove(path: string): Promise<void> {
    if (this.isPathUnderReservedDir(path)) {
      console.error(
        `[VaultEngine] refusing to delete materialised path "${path}" — ` +
          `it falls under the reserved ${META_DIR}/ metadata directory.`,
      );
      await this.diag("refuse-reserved-path-remove", { detail: path });
      return;
    }
    await this.docStore.removeMaterialized(path);
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
    await engine.initializeIndexes();
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
    options: { lazyDocuments?: boolean } = {},
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
    markBoot("tree-loaded");

    const engine = new VaultEngine(tree, treeStore, docStore, vaultId);

    // 2. Active document IDs from tree (source of truth)
    const activeIds = tree.documentIds();
    for (const node of tree.allNodes()) {
      if (node.kind !== "binary") continue;
      const path = buildPathFromNode(tree, node);
      if (path) engine.materializedAssetPaths.set(String(node.treeId), path);
    }

    // 3. Load only active documents, a few at a time (each is several
    // storage round-trips; one after another they dominated startup). With
    // `lazyDocuments` (the browser) this happens in the background and the
    // engine is usable as soon as the tree is: see loadDocument and
    // whenAllDocumentsLoaded.
    for (const id of activeIds) engine.unloadedIds.add(id);
    engine.allDocumentsLoaded = mapConcurrent(activeIds, DOC_LOAD_CONCURRENCY, (id) =>
      engine.loadStoredDocument(id),
    ).then(async () => {
      markBoot("documents-loaded");
      // Anything indexed before every document was in is incomplete.
      engine.searchStale = true;
      engine.derivedStale = true;
      if (engine.migratedLegacyIds.length > 0) {
        await engine.diag("legacy-id-migration", {
          counts: { migrated: engine.migratedLegacyIds.length },
          detail: engine.migratedLegacyIds.join(","),
        });
      }
    });
    if (!options.lazyDocuments) await engine.allDocumentsLoaded;

    // 4. Recovery diff — does NOT resurrect deleted docs
    const persistedIds = await docStore.listDocumentIds();
    const activeSet = new Set(activeIds);
    const persistedSet = new Set(persistedIds);

    const recovery: VaultRecoveryReport = {
      activeIds,
      persistedIds,
      missingDocs: activeIds.filter((id) => !persistedSet.has(id)),
      orphanedDocs: persistedIds.filter((id) => !activeSet.has(id)),
      migratedLegacyIds: engine.migratedLegacyIds,
    };

    await engine.initializeIndexes();
    markBoot("indexes-ready");

    return { engine, recovery };
  }

  /** Documents in the tree whose stored state hasn't been read yet. */
  unloadedIds = new Set<string>();
  documentLoads = new Map<string, Promise<void>>();
  allDocumentsLoaded: Promise<void> = Promise.resolve();
  migratedLegacyIds: string[] = [];

  /** Resolves once every document the tree had at open has been loaded. */
  whenAllDocumentsLoaded(): Promise<void> {
    return this.allDocumentsLoaded;
  }

  /**
   * Load one document's stored state now, ahead of the background load
   * (the note being opened, a room being synced). Resolves to the document,
   * or undefined if the tree doesn't have it.
   */
  async loadDocument(documentId: string): Promise<Document | undefined> {
    await this.loadStoredDocument(documentId);
    return this.documents.get(documentId);
  }

  /** @internal */
  loadStoredDocument(id: string): Promise<void> { return persist.loadStoredDocument(this, id); }


  getDocument(id: string): Document | undefined {
    return this.documents.get(id);
  }

  /**
   * Subscribe to a document that may be created by a later sync round.
   * Tree membership and document content arrive independently, so an editor
   * can mount while the tree row exists but its Document is not in memory yet.
   */
  onDocumentAvailable(documentId: string, listener: () => void): () => void {
    if (this.documents.has(documentId)) return () => undefined;
    const listeners = this.documentAvailableListeners.get(documentId) ?? new Set();
    listeners.add(listener);
    this.documentAvailableListeners.set(documentId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.documentAvailableListeners.delete(documentId);
    };
  }

  listDocuments(): Document[] {
    return Array.from(this.documents.values());
  }

  /** Search note titles and Markdown content with MiniSearch ranking. */
  search(query: string, limit = 50): DocIndexEntry[] { return indexes.search(this, query, limit); }

  /** Return notes that contain a wikilink targeting this document. */
  backlinksFor(documentId: string): BacklinkEntry[] { return indexes.backlinksFor(this, documentId); }

  /** @internal */
  indexedDocument(documentId: string): IndexedDocument | null {
    return indexes.indexedDocument(this, documentId);
  }

  /** @internal */
  allIndexedDocuments(): IndexedDocument[] { return indexes.allIndexedDocuments(this); }

  /** @internal */
  initializeIndexes(): Promise<void> { return indexes.initializeIndexes(this); }

  /** The search index is built lazily; see initializeIndexes. */
  searchStale = false;

  /** @internal */
  rebuildSearchIfStale(): void { return indexes.rebuildSearchIfStale(this); }

  /** @internal */
  queueIndexPersist(): Promise<void> { return indexes.queueIndexPersist(this); }

  /** Write the derived caches now if a write is pending. */
  flushIndexes(): Promise<void> { return indexes.flushIndexes(this); }

  /** Backlinks/graph are recomputed lazily, on first read after a change. */
  derivedStale = false;

  /** @internal */
  recomputeDerivedIfStale(): void { return indexes.recomputeDerivedIfStale(this); }

  /** @internal */
  indexSearchDocument(documentId: string): void { return indexes.indexSearchDocument(this, documentId); }

  /** @internal */
  updateIndexesForDocument(documentId: string): Promise<void> {
    return indexes.updateIndexesForDocument(this, documentId);
  }

  /** @internal */
  refreshIndexes(): Promise<void> { return indexes.refreshIndexes(this); }

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
    this.setDocument(docId, doc);
    if (this.searchIndexReady) this.indexSearchDocument(docId);
    return doc;
  }

  /** Return the user-visible path for a tracked binary asset. */
  attachmentPath(treeId: TreeID): string | null { return attachments.attachmentPath(this, treeId); }

  /** Read an attachment by stable tree node id. */
  readAttachment(treeId: TreeID): Promise<Uint8Array | null> {
    return attachments.readAttachment(this, treeId);
  }

  /** Create an attachment under Attachments/ or an explicit folder. */
  createAttachment(name: string, bytes: Uint8Array, parentTreeId?: TreeID): Promise<VaultTreeNode> {
    return attachments.createAttachment(this, name, bytes, parentTreeId);
  }

  /** Store downloaded/synced bytes for an existing binary tree node. */
  writeAttachment(treeId: TreeID, bytes: Uint8Array): Promise<void> {
    return attachments.writeAttachment(this, treeId, bytes);
  }

  /** Delete an attachment node and its ordinary on-disk bytes. */
  deleteAttachment(treeId: TreeID): Promise<void> { return attachments.deleteAttachment(this, treeId); }

  /** Rename a binary node and move its ordinary bytes to the new path. */
  renameAttachment(treeId: TreeID, newName: string): Promise<void> {
    return attachments.renameAttachment(this, treeId, newName);
  }

  /** Adopt ordinary files placed anywhere in the visible vault by an external actor. */
  ingestExternalAssets(): Promise<AssetIngestReport> { return attachments.ingestExternalAssets(this); }

  /** Adopt ordinary directories created outside the app. */
  ingestExternalFolders(): Promise<{ created: string[] }> { return attachments.ingestExternalFolders(this); }

  /** @internal */
  ensureAttachmentsFolder(): TreeID { return attachments.ensureAttachmentsFolder(this); }

  /** Materialise one document to disk (§11): - compute hash of the Markdown content - write .md atomically via… */
  materializeDocument(documentId: string, filePath: string): Promise<MaterializationCheckpoint | null> {
    return materialize.materializeDocument(this, documentId, filePath);
  }

  /** Materialise all tree-tracked documents. */
  materializeAll(rootPath: string): Promise<Map<string, MaterializationCheckpoint>> {
    return materialize.materializeAll(this, rootPath);
  }

  /** Materialise specific documents at their current tree path. */
  materializeDocuments(documentIds: Iterable<string>): Promise<void> {
    return materialize.materializeDocuments(this, documentIds);
  }

  /** @internal */
  materializeToTreePath(documentId: string): Promise<boolean> {
    return materialize.materializeToTreePath(this, documentId);
  }

  /** Load the sidecar doc index (SPEC §5/§26): relative path -> {id, contentHash, size, mtime}, as of the last… */
  loadDocIndex(): Promise<DocIndex> { return docIndex.loadDocIndex(this); }

  /** @internal */
  readDocIndexFromDisk(): Promise<DocIndex> { return docIndex.readDocIndexFromDisk(this); }

  /** Replace the index and write it. */
  saveDocIndex(index: DocIndex): Promise<void> { return docIndex.saveDocIndex(this, index); }

  /** @internal */
  seedDocIndexFromTree(): Promise<DocIndex> { return docIndex.seedDocIndexFromTree(this); }

  /** @internal */
  touchIndexEntry(path: string, documentId: string, content: string, frontiers?: OpId[]): Promise<void> {
    return docIndex.touchIndexEntry(this, path, documentId, content, frontiers);
  }

  /** True when a document's file on disk no longer matches what this engine last wrote or ingested there — an… */
  hasPendingExternalEdit(documentId: string): Promise<boolean> {
    return docIndex.hasPendingExternalEdit(this, documentId);
  }

  /** @internal */
  externalEditPendingAt(path: string, aboutToWrite?: string): Promise<boolean> {
    return docIndex.externalEditPendingAt(this, path, aboutToWrite);
  }

  /** @internal */
  deferWriteForExternalEdit(documentId: string, path: string): Promise<void> {
    return docIndex.deferWriteForExternalEdit(this, documentId, path);
  }

  /** Drop the cached doc index so the next use re-reads the file. */
  forgetCachedDocIndex(): void { return docIndex.forgetCachedDocIndex(this); }

  /** @internal */
  dropIndexEntry(path: string): Promise<void> { return docIndex.dropIndexEntry(this, path); }

  /**
   * Ingest external filesystem changes into the CRDT/tree (see
   * engine/ingest.ts). Passes never overlap: startup's background
   * reconcile, the browser's visibility check and the server's watcher can
   * all ask for one.
   */
  ingestExternalChanges(): Promise<IngestReport> {
    const run = this.ingestChain.then(() => this.ingestExternalChangesNow());
    this.ingestChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  ingestChain: Promise<void> = Promise.resolve();

  /** @internal */
  ingestExternalChangesNow(): Promise<IngestReport> { return ingest.ingestExternalChangesNow(this); }

  /** @internal */
  ensureFolderPath(segments: string[], created?: string[]): TreeID | undefined {
    return ingest.ensureFolderPath(this, segments, created);
  }

  /** Resolve post-merge same-name sibling collisions, moving renamed notes' files. */
  resolveTreeNameCollisions(): Promise<string[]> { return ingest.resolveTreeNameCollisions(this); }

  /** Make disk mirror the tree: ingest external changes, then rewrite stale files and sweep orphans. */
  reconcileMaterialization(): Promise<{ ingested: IngestReport; materialized: string[]; removed: string[] }> {
    return ingest.reconcileMaterialization(this);
  }

  /** Check if a materialised file is stale compared to the CRDT document. */
  isStale(documentId: string, filePath: string): Promise<boolean> {
    return materialize.isStale(this, documentId, filePath);
  }

  /** Repair: rewrite a stale or missing materialised file for one document. */
  repairDocument(documentId: string, filePath: string): Promise<MaterializationCheckpoint | null> {
    return materialize.repairDocument(this, documentId, filePath);
  }

  /** Import a document update (from sync or external source). */
  async importDocumentUpdate(documentId: string, data: Uint8Array): Promise<void> {
    await this.loadStoredDocument(documentId);
    const doc = this.ensureDocument(documentId);
    doc.doc.import(data);
    await this.updateIndexesForDocument(documentId);
  }

  /**
   * Get the Document for `documentId`, creating an empty one in memory if
   * it isn't tracked yet. Needed for sync: a document's tree node and its
   * own room sync independently, in no guaranteed order — content (via
   * `doc:<id>`) can arrive here before the vault-tree room has told this
   * engine the id even exists. Never touches the tree; that room owns
   * membership. (This closes the gap where a client discovering a new
   * document purely via tree sync had nowhere to import the incoming
   * room's CRDT updates into — `getDocument()` returned undefined and the
   * update was silently dropped.)
   */
  ensureDocument(documentId: string): Document {
    let doc = this.documents.get(documentId);
    if (!doc) {
      doc = new Document(documentId);
      this.setDocument(documentId, doc);
    }
    return doc;
  }

  setDocument(documentId: string, document: Document): void {
    this.documents.set(documentId, document);
    const listeners = this.documentAvailableListeners.get(documentId);
    if (!listeners) return;
    this.documentAvailableListeners.delete(documentId);
    for (const listener of listeners) listener();
  }

  /** Persist a new commit as an incremental update segment; compact when thresholds are breached (§10). */
  persistDocumentIncremental(documentId: string, rules: CompactionRules = DEFAULT_COMPACTION_RULES): Promise<{ compacted: boolean }> {
    return persist.persistDocumentIncremental(this, documentId, rules);
  }

  persistChains = new Map<string, Promise<void>>();

  /** @internal */
  persistDocumentNow(documentId: string, rules: CompactionRules): Promise<{ compacted: boolean }> {
    return persist.persistDocumentNow(this, documentId, rules);
  }

  /** Incremental persist the vault-tree CRDT with compaction. */
  persistTreeIncremental(rules: CompactionRules = DEFAULT_COMPACTION_RULES): Promise<{ compacted: boolean }> {
    return persist.persistTreeIncremental(this, rules);
  }

  /** Persist the vault tree via compact() (separate from doc persistence). */
  persistTree(): Promise<void> { return persist.persistTree(this); }

  /** Rename a note: renames the tree node's file name only. */
  renameDocument(documentId: string, newTitle: string): Promise<void> {
    return treeOps.renameDocument(this, documentId, newTitle);
  }

  /** Delete a note: removes it from the vault tree (source of truth for which documents are active) and drops… */
  deleteDocument(documentId: string): Promise<void> { return treeOps.deleteDocument(this, documentId); }

  /** Make materialized files and directories follow a tree update from sync. */
  applyTreeToDisk(previousDirectoryPaths: readonly string[] = []): Promise<{ removed: string[]; moved: string[] }> {
    return treeOps.applyTreeToDisk(this, previousDirectoryPaths);
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

  /** Move a tree node (note or folder) to a new parent at an optional index. */
  moveNode(treeId: TreeID, newParentTreeId: TreeID | undefined, index?: number): Promise<void> {
    return treeOps.moveNode(this, treeId, newParentTreeId, index);
  }

  /** Rename a folder node (directory kind, not a document). */
  renameFolder(treeId: TreeID, newName: string): Promise<void> {
    return treeOps.renameFolder(this, treeId, newName);
  }

  /** @internal */
  rematerializeSubtree(treeId: TreeID): Promise<void> { return treeOps.rematerializeSubtree(this, treeId); }

  /** @internal */
  rematerializeAsset(treeId: TreeID, node: VaultTreeNode): Promise<void> {
    return attachments.rematerializeAsset(this, treeId, node);
  }

  /** Delete a folder and everything beneath it. */
  deleteFolder(treeId: TreeID): Promise<void> { return treeOps.deleteFolder(this, treeId); }

}
