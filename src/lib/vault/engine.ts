import { LEGACY_META_DIRS, META_DIR, isMetaDirName } from "@/lib/core/paths";
import { markBoot } from "@/lib/core/boot-marks";
import { type OpId, type TreeID } from "loro-crdt";
import { VaultTree, type VaultTreeNode } from "@/lib/vault/tree";
import { Document, CONTENT_KEY } from "@/lib/core/document";
import type { PersistedDocStore, VaultTreeStore } from "@/lib/vault/store";
import type {
  DirtyRoom,
  DocIndexEntry,
  MaterializationCheckpoint,
  PersistedDocState,
} from "@/lib/core/types";
import { sha256Hex, sha256Text } from "@/lib/core/hash";
import { extractIdFromMarkdown, stripIdComment } from "@/lib/core/doc-id";
import { parseMarkdown } from "@/lib/core/markdown";
import { reconcileVault, type DocIndex, type FileSnapshot } from "@/lib/core/doc-index";
import { mergeExternalEdit } from "@/lib/core/merge";
import {
  shouldCompact,
  DEFAULT_COMPACTION_RULES,
  type CompactionRules,
} from "@/lib/vault/compact";
import { recordDiagnostic } from "@/lib/vault/diagnostics";
import { attachmentMimeType } from "@/lib/vault/attachments";
import {
  DerivedIndexes,
  SearchIndex,
  searchIndexStorageFromDocStore,
  toIndexedDocument,
  type BacklinkEntry,
  type IndexedDocument,
} from "@/lib/search/index";

/** Result of one `ingestExternalChanges()` pass, grouped by what happened. */
export interface IngestReport {
  /** Known paths whose content changed externally — merged into the CRDT. */
  edited: string[];
  /** Content moved/renamed to a new path — tree updated, id preserved. */
  moved: string[];
  /** Content duplicated onto a new path while the original still exists. */
  copied: string[];
  /** Genuinely new external files, adopted as new documents. */
  created: string[];
  /** Indexed paths that disappeared and weren't claimed by a move. */
  deleted: string[];
  /** Binary files adopted from the user-visible Attachments/ folder. */
  assetsCreated?: string[];
  /** Tracked binary files whose bytes changed outside the app. */
  assetsUpdated?: string[];
  /** Ordinary folders created outside the app and adopted into the tree. */
  foldersCreated?: string[];
}

export interface AssetIngestReport {
  created: string[];
  updated: string[];
}

export const ATTACHMENTS_FOLDER_NAME = "Attachments";

const IGNORED_EXTERNAL_DIRECTORY_SEGMENTS = new Set([
  META_DIR,
  ...LEGACY_META_DIRS,
  ".git",
  ".obsidian",
  ".trash",
  "node_modules",
]);

/** Return whether a materialized path belongs to app/tool metadata. */
export function isIgnoredExternalPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.endsWith(".tmp") || normalized
    .split("/")
    .some((segment) => IGNORED_EXTERNAL_DIRECTORY_SEGMENTS.has(segment.toLowerCase()));
}

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** Where the sidecar doc index (SPEC §5) lives, relative to the vault root. */
const DOC_INDEX_PATH = `${META_DIR}/index.json`;

/** How many documents' stored state is read at once when opening a vault. */
const DOC_LOAD_CONCURRENCY = 16;

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight; keeps order. */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** How long derived-cache writes wait for more changes to batch. */
const INDEX_PERSIST_DEBOUNCE_MS = 400;

/** Derived-cache writes are best-effort: log and carry on. */
function skipCachePersist(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("writer lock")) return; // read-only tab: expected
  console.error("[indexes] failed to persist derived indexes", error);
}

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
  private documentAvailableListeners = new Map<string, Set<() => void>>();
  /**
   * Last path each doc was materialised at, tracked in memory so a
   * subsequent rename/move can delete the stale file instead of leaving it
   * behind. Derived at boot (assumed = current tree path; reconcile()
   * corrects anything that turns out to be wrong) and kept current by every
   * materialize/rename/move/delete call.
   */
  private materializedPaths = new Map<string, string>();
  /** Index paths written while an ingest pass applies its results. */
  private indexTouchesThisPass: Set<string> | null = null;
  /** In-memory doc index; see loadDocIndex. */
  private docIndexCache: DocIndex | null = null;
  private docIndexWriteChain: Promise<void> = Promise.resolve();
  private docIndexWriteQueued: Promise<void> | null = null;
  private deferDocIndexWrites = false;
  /** Pending debounced write of the derived search/backlink/graph caches. */
  private indexPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private indexPersistWaiters: Array<() => void> = [];
  private materializedAssetPaths = new Map<string, string>();
  private readonly searchIndex: SearchIndex;
  private readonly derivedIndexes: DerivedIndexes;
  private searchIndexReady = false;
  private indexPersistChain: Promise<void> = Promise.resolve();

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
  private isPathUnderReservedDir(path: string): boolean {
    if (path === DOC_INDEX_PATH) return false;
    const top = path.split("/")[0]!;
    return isMetaDirName(top);
  }

  /** Best-effort diagnostics append — never throws, never blocks the caller. */
  private async diag(op: string, options?: { counts?: Record<string, number>; detail?: string }): Promise<void> {
    await recordDiagnostic(this.docStore, op, options);
  }

  private async materializedWrite(path: string, bytes: Uint8Array): Promise<void> {
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

  private async materializedRemove(path: string): Promise<void> {
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
  private unloadedIds = new Set<string>();
  private documentLoads = new Map<string, Promise<void>>();
  private allDocumentsLoaded: Promise<void> = Promise.resolve();
  private migratedLegacyIds: string[] = [];

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

  private loadStoredDocument(id: string): Promise<void> {
    const inFlight = this.documentLoads.get(id);
    if (inFlight) return inFlight;
    if (!this.unloadedIds.has(id)) return Promise.resolve();
    const load = (async () => {
      const snapshot = await this.docStore.loadSnapshot(id);
      const updates = await this.docStore.loadUpdates(id);
      this.unloadedIds.delete(id);
      // Deleted while its bytes were being read: don't bring it back.
      const node = this.tree.findByDocumentId(id);
      if (!node) return;
      // A sync may already have created the document (ensureDocument) and
      // merged remote changes into it; merge the stored state in too.
      const doc = this.documents.get(id) ?? new Document(id);
      if (snapshot) doc.doc.import(snapshot);
      for (const update of updates) doc.doc.import(update);
      doc.doc.commit();

      // One-time migration: strip any legacy `adhd:id` comment still
      // living in previously-persisted LoroText (see
      // Document.migrateLegacyIdComment). This is a real CRDT edit, so
      // persist it immediately so it survives and syncs.
      if (doc.migrateLegacyIdComment()) {
        this.migratedLegacyIds.push(id);
        try {
          await this.docStore.appendUpdate(id, doc.doc.export({ mode: "update" }));
        } catch (error) {
          // A read-only tab may not write (§12); the writer tab migrates it.
          console.warn(`[VaultEngine] legacy-id migration of ${id} not persisted here`, error);
        }
      }

      // Derive the assumed on-disk path from the tree; reconcileMaterialization()
      // verifies this against reality (missing/stale files, orphaned paths).
      const assumedPath = buildPathFromNode(this.tree, node);
      if (assumedPath && !this.materializedPaths.has(id)) this.materializedPaths.set(id, assumedPath);
      if (!this.documents.has(id)) this.setDocument(id, doc);
      else if (this.searchIndexReady) this.indexSearchDocument(id);
    })();
    this.documentLoads.set(id, load);
    void load.finally(() => this.documentLoads.delete(id)).catch(() => undefined);
    return load;
  }

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
  search(query: string, limit = 50): DocIndexEntry[] {
    this.rebuildSearchIfStale();
    return this.searchIndex.search(query, limit);
  }

  /** Return notes that contain a wikilink targeting this document. */
  backlinksFor(documentId: string): BacklinkEntry[] {
    this.recomputeDerivedIfStale();
    return this.derivedIndexes.backlinksFor(documentId);
  }

  private indexedDocument(documentId: string): IndexedDocument | null {
    const node = this.tree.findByDocumentId(documentId);
    const doc = this.documents.get(documentId);
    if (!node || node.kind !== "markdown" || !node.documentId || !doc) return null;
    const path = buildPathFromNode(this.tree, node);
    if (!path) return null;
    doc.doc.commit();
    return toIndexedDocument(parseMarkdown(doc.getMarkdown(), path), path, documentId);
  }

  private allIndexedDocuments(): IndexedDocument[] {
    return this.tree
      .allNodes()
      .filter((node) => node.kind === "markdown" && Boolean(node.documentId))
      .map((node) => this.indexedDocument(node.documentId!))
      .filter((doc): doc is IndexedDocument => doc !== null);
  }

  /**
   * Opening the vault doesn't build the indexes: parsing and indexing every
   * note was a large share of startup, before anything could be shown (spec
   * item 20). The search index is built on the first search and the
   * backlink/graph maps on the first read (both from current CRDT content),
   * then kept up to date incrementally; the caches are written (batched)
   * after changes, not at startup.
   */
  private async initializeIndexes(): Promise<void> {
    this.searchStale = true;
    this.derivedStale = true;
    this.searchIndexReady = true;
  }

  /** The search index is built lazily; see initializeIndexes. */
  private searchStale = false;

  private rebuildSearchIfStale(): void {
    if (!this.searchStale) return;
    this.searchStale = false;
    this.searchIndex.replaceAll(this.allIndexedDocuments());
  }

  /**
   * The search, backlink and graph caches are derived (SPEC §3) and only
   * read at the next startup, so their writes are debounced: a burst of
   * changes (a sync round, an import) writes them once, not once per note.
   * The in-memory indexes are always current. Resolves once the write that
   * includes this change has finished.
   */
  private queueIndexPersist(): Promise<void> {
    const done = new Promise<void>((resolve) => this.indexPersistWaiters.push(resolve));
    if (this.indexPersistTimer) clearTimeout(this.indexPersistTimer);
    this.indexPersistTimer = setTimeout(() => void this.flushIndexes(), INDEX_PERSIST_DEBOUNCE_MS);
    (this.indexPersistTimer as { unref?: () => void }).unref?.();
    return done;
  }

  /** Write the derived caches now if a write is pending. */
  async flushIndexes(): Promise<void> {
    if (this.indexPersistTimer) {
      clearTimeout(this.indexPersistTimer);
      this.indexPersistTimer = null;
    }
    const waiters = this.indexPersistWaiters.splice(0);
    if (waiters.length === 0) return this.indexPersistChain;
    this.indexPersistChain = this.indexPersistChain
      .then(async () => {
        await this.allDocumentsLoaded;
        this.rebuildSearchIfStale();
        await this.searchIndex.persist();
        this.derivedStale = false;
        await this.derivedIndexes.build(this.allIndexedDocuments());
      })
      .catch((error) => skipCachePersist(error))
      .finally(() => waiters.forEach((resolve) => resolve()));
    return this.indexPersistChain;
  }

  /** Backlinks/graph are recomputed lazily, on first read after a change. */
  private derivedStale = false;

  private recomputeDerivedIfStale(): void {
    if (!this.derivedStale) return;
    this.derivedStale = false;
    this.derivedIndexes.compute(this.allIndexedDocuments());
  }

  private indexSearchDocument(documentId: string): void {
    // A pending full rebuild will pick this document up.
    if (this.searchStale) return;
    const indexed = this.indexedDocument(documentId);
    if (indexed) this.searchIndex.add(indexed);
    else this.searchIndex.remove(documentId);
  }

  private async updateIndexesForDocument(documentId: string): Promise<void> {
    if (!this.searchIndexReady) return;
    this.indexSearchDocument(documentId);
    this.derivedStale = true;
    void this.queueIndexPersist();
  }

  private async refreshIndexes(): Promise<void> {
    if (!this.searchIndexReady) return;
    this.searchStale = true;
    this.derivedStale = true;
    void this.queueIndexPersist();
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
    this.setDocument(docId, doc);
    if (this.searchIndexReady) this.indexSearchDocument(docId);
    return doc;
  }

  /** Return the user-visible path for a tracked binary asset. */
  attachmentPath(treeId: TreeID): string | null {
    const node = this.tree.getNode(treeId);
    if (!node || node.kind !== "binary") return null;
    return buildPathFromNode(this.tree, node);
  }

  /** Read an attachment by stable tree node id. */
  async readAttachment(treeId: TreeID): Promise<Uint8Array | null> {
    const path = this.attachmentPath(treeId);
    return path ? this.docStore.readMaterialized(path) : null;
  }

  /** Create an attachment under Attachments/ or an explicit folder. */
  async createAttachment(
    name: string,
    bytes: Uint8Array,
    parentTreeId?: TreeID,
  ): Promise<VaultTreeNode> {
    const parent = parentTreeId ?? this.ensureAttachmentsFolder();
    const sha256 = await sha256Hex(bytes);
    const treeId = this.tree.addBinaryFile(parent, name, {
      sha256,
      size: bytes.byteLength,
      mime: attachmentMimeType(name),
    });
    const node = this.tree.getNode(treeId);
    if (!node) throw new Error("Attachment tree node was not created");
    const path = buildPathFromNode(this.tree, node);
    if (!path) throw new Error("Attachment path was not created");
    try {
      await this.materializedWrite(path, bytes);
      this.materializedAssetPaths.set(String(treeId), path);
      await this.persistTreeIncremental();
    } catch (error) {
      // The tree edit has not been durably committed when the byte write or
      // tree append fails. Remove the in-memory node so a caller can retry
      // without leaving a phantom asset in the current session. A successfully
      // written but uncommitted ordinary file remains recoverable as an
      // external file on the next reconciliation pass.
      this.tree.delete(treeId);
      this.materializedAssetPaths.delete(String(treeId));
      throw error;
    }
    return node;
  }

  /** Store downloaded/synced bytes for an existing binary tree node. */
  async writeAttachment(treeId: TreeID, bytes: Uint8Array): Promise<void> {
    const node = this.tree.getNode(treeId);
    if (!node || node.kind !== "binary") throw new Error(`Binary asset not found: ${treeId}`);
    const digest = await sha256Hex(bytes);
    if (node.sha256 && node.sha256 !== digest) {
      throw new Error(`Attachment hash mismatch for ${treeId}`);
    }
    const path = buildPathFromNode(this.tree, node);
    if (!path) throw new Error(`Attachment path not found: ${treeId}`);
    await this.materializedWrite(path, bytes);
    this.materializedAssetPaths.set(String(treeId), path);
  }

  /** Delete an attachment node and its ordinary on-disk bytes. */
  async deleteAttachment(treeId: TreeID): Promise<void> {
    const node = this.tree.getNode(treeId);
    if (!node || node.kind !== "binary") throw new Error(`Binary asset not found: ${treeId}`);
    const path = this.materializedAssetPaths.get(String(treeId)) ?? buildPathFromNode(this.tree, node);
    this.tree.delete(treeId);
    this.materializedAssetPaths.delete(String(treeId));
    if (path) await this.materializedRemove(path);
    await this.persistTree();
  }

  /** Rename a binary node and move its ordinary bytes to the new path. */
  async renameAttachment(treeId: TreeID, newName: string): Promise<void> {
    const node = this.tree.getNode(treeId);
    if (!node || node.kind !== "binary") throw new Error(`Binary asset not found: ${treeId}`);
    this.tree.rename(treeId, newName);
    await this.rematerializeSubtree(treeId);
    await this.persistTreeIncremental();
  }

  /** Adopt ordinary files placed anywhere in the visible vault by an external actor. */
  async ingestExternalAssets(): Promise<AssetIngestReport> {
    const tracked = new Set(
      this.tree.allNodes()
        .filter((node) => node.kind === "binary")
        .map((node) => buildPathFromNode(this.tree, node))
        .filter((path): path is string => path !== null),
    );
    const created: string[] = [];
    for (const path of await this.docStore.listMaterializedPaths()) {
      if (isIgnoredExternalPath(path) || isMarkdownPath(path) || tracked.has(path)) continue;
      const bytes = await this.docStore.readMaterialized(path);
      if (!bytes) continue;
      const parts = path.split("/");
      const name = parts.pop();
      if (!name) continue;
      const parent = this.ensureFolderPath(parts);
      const treeId = this.tree.addBinaryFile(parent, name, {
        sha256: await sha256Hex(bytes),
        size: bytes.byteLength,
        mime: attachmentMimeType(name),
      });
      this.materializedAssetPaths.set(String(treeId), path);
      created.push(String(treeId));
    }
    const updated: string[] = [];
    for (const node of this.tree.allNodes()) {
      if (node.kind !== "binary") continue;
      const path = buildPathFromNode(this.tree, node);
      if (!path || isIgnoredExternalPath(path) || !tracked.has(path)) continue;
      const bytes = await this.docStore.readMaterialized(path);
      if (!bytes) continue;
      const sha256 = await sha256Hex(bytes);
      const mime = attachmentMimeType(node.name);
      if (node.sha256 === sha256 && node.size === bytes.byteLength && node.mime === mime) continue;
      this.tree.updateBinaryMetadata(node.treeId, {
        sha256,
        size: bytes.byteLength,
        mime,
      });
      updated.push(String(node.treeId));
    }
    if (created.length > 0 || updated.length > 0) await this.persistTree();
    return { created, updated };
  }

  /**
   * Adopt ordinary directories created outside the app. Files are still the
   * portable source of truth for notes, but a filesystem can also contain an
   * intentionally empty folder, so directory events need their own pass.
   * Metadata/dependency directories remain invisible just like an Obsidian
   * import's skipped folders.
   */
  async ingestExternalFolders(): Promise<{ created: string[] }> {
    const listDirectories = this.docStore.listMaterializedDirectories;
    if (!listDirectories) return { created: [] };

    const created: string[] = [];
    const paths = (await listDirectories.call(this.docStore))
      .map((path) => path.replaceAll("\\", "/").split("/").filter(Boolean))
      .filter((segments) =>
        segments.length > 0 &&
        !segments.some((segment) => IGNORED_EXTERNAL_DIRECTORY_SEGMENTS.has(segment.toLowerCase())),
      )
      .sort((a, b) => a.length - b.length);

    for (const segments of paths) {
      this.ensureFolderPath(segments, created);
    }

    if (created.length > 0) await this.persistTree();
    return { created };
  }

  private ensureAttachmentsFolder(): TreeID {
    const existing = this.tree.roots().find(
      (node) => node.kind === "directory" && node.name === ATTACHMENTS_FOLDER_NAME,
    );
    return existing?.treeId ?? this.tree.addDirectory(undefined, ATTACHMENTS_FOLDER_NAME);
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
    await this.loadStoredDocument(documentId);
    const doc = this.documents.get(documentId);
    if (!doc) return null;

    doc.doc.commit();
    const markdown = doc.getText(CONTENT_KEY).toString();
    const frontiers = doc.doc.oplogFrontiers();
    const hash = await sha256Text(markdown);

    if (await this.externalEditPendingAt(filePath, markdown)) {
      await this.deferWriteForExternalEdit(documentId, filePath);
      return null;
    }

    // 1. Write materialised .md atomically (UTF-8 only here)
    const mdBytes = new TextEncoder().encode(markdown);
    await this.materializedWrite(filePath, mdBytes);

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
    await this.touchIndexEntry(filePath, documentId, markdown, frontiers);
    await this.updateIndexesForDocument(documentId);

    return checkpoint;
  }

  /**
   * Materialise all tree-tracked documents. Used on first boot and repair.
   * Returns a recovery report so callers know what changed.
   */
  async materializeAll(
    rootPath: string,
  ): Promise<Map<string, MaterializationCheckpoint>> {
    await this.allDocumentsLoaded;
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
  private async materializeToTreePath(documentId: string): Promise<boolean> {
    const node = this.tree.findByDocumentId(documentId);
    const doc = this.documents.get(documentId);
    if (!node || !doc) return true;
    const newPath = buildPathFromNode(this.tree, node);
    if (!newPath) return true;
    const oldPath = this.materializedPaths.get(documentId);
    doc.doc.commit();
    const content = doc.getText(CONTENT_KEY).toString();
    if (await this.externalEditPendingAt(newPath, content)) {
      await this.deferWriteForExternalEdit(documentId, newPath);
      return false;
    }
    const bytes = new TextEncoder().encode(content);
    await this.materializedWrite(newPath, bytes);
    if (oldPath && oldPath !== newPath) {
      await this.materializedRemove(oldPath);
      await this.dropIndexEntry(oldPath);
    }
    this.materializedPaths.set(documentId, newPath);
    await this.touchIndexEntry(newPath, documentId, content, doc.doc.oplogFrontiers());
    await this.updateIndexesForDocument(documentId);
    return true;
  }

  /**
   * Load the sidecar doc index (SPEC §5/§26): relative path -> {id,
   * contentHash, size, mtime}, as of the last time the app itself wrote to
   * disk (materialize/remove). It is the "last written by app" marker that
   * lets ingestExternalChanges() tell an external edit/move/copy apart from
   * the app's own writes. Stored at `.methyl/index.json`, outside the
   * directories `listMaterializedPaths()` walks, so it's invisible to
   * normal vault listing.
   *
   * If absent (first run against an existing vault, or after deleting
   * `.methyl`), it's seeded from the current tree + whatever is already
   * materialised on disk, so that run treats the existing vault as the
   * known baseline rather than "everything is new".
   */
  async loadDocIndex(): Promise<DocIndex> {
    // This engine is the index file's only writer, so after the first read
    // the in-memory copy is authoritative. Re-reading and re-parsing it on
    // every note write made bulk operations quadratic.
    if (this.docIndexCache) return this.docIndexCache;
    this.docIndexCache = await this.readDocIndexFromDisk();
    return this.docIndexCache;
  }

  private async readDocIndexFromDisk(): Promise<DocIndex> {
    const bytes = await this.docStore.readMaterialized(DOC_INDEX_PATH);
    if (!bytes) return this.seedDocIndexFromTree();
    let parsed: DocIndex;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as DocIndex;
    } catch {
      return this.seedDocIndexFromTree();
    }
    // Safety rail: an index that reads back as `{}` (or otherwise empty)
    // while the tree already tracks documents is not trustworthy ground
    // truth — it's either a fresh/never-populated index file or, worse,
    // exactly the aftermath of the bug this rail is closing (a bad ingest
    // pass wrote an empty index over a real one). Either way, an *empty*
    // index must never be read as "so every currently-tracked document is
    // an external deletion candidate" — reseed from what the tree actually
    // knows instead of trusting it blindly.
    if (Object.keys(parsed).length === 0 && this.tree.documentIds().length > 0) {
      return this.seedDocIndexFromTree();
    }
    return parsed;
  }

  /**
   * Replace the index and write it. Writes are coalesced: a save requested
   * while one is waiting shares that write, which always writes the newest
   * index. While an ingest pass is applying its results the file isn't
   * written at all until the pass saves its final index.
   */
  saveDocIndex(index: DocIndex): Promise<void> {
    this.docIndexCache = index;
    if (this.deferDocIndexWrites) return Promise.resolve();
    if (this.docIndexWriteQueued) return this.docIndexWriteQueued;
    const next = this.docIndexWriteChain.then(async () => {
      this.docIndexWriteQueued = null;
      await this.docStore.writeMaterializedAtomic(
        DOC_INDEX_PATH,
        new TextEncoder().encode(JSON.stringify(this.docIndexCache ?? {})),
      );
    });
    this.docIndexWriteQueued = next;
    this.docIndexWriteChain = next.catch(() => undefined);
    return next;
  }

  private async seedDocIndexFromTree(): Promise<DocIndex> {
    const index: DocIndex = {};
    for (const node of this.tree.allNodes()) {
      if (node.kind !== "markdown" || !node.documentId) continue;
      const path = buildPathFromNode(this.tree, node);
      if (!path) continue;
      const bytes = await this.docStore.readMaterialized(path);
      if (!bytes) continue;
      const raw = new TextDecoder().decode(bytes);
      const legacyId = extractIdFromMarkdown(raw);
      const content = legacyId ? stripIdComment(raw) : raw;
      index[path] = {
        id: node.documentId,
        contentHash: await sha256Text(content),
        size: content.length,
        mtime: Date.now(),
      };
    }
    return index;
  }

  /**
   * Record that the app itself just wrote `path` with `content`, so the
   * next ingest recognises it as its own write rather than an external
   * change (requirement: "app writes must not be re-ingested as
   * external"). Called by every path that writes a materialised `.md`.
   */
  private async touchIndexEntry(
    path: string,
    documentId: string,
    content: string,
    frontiers?: OpId[],
  ): Promise<void> {
    const index = await this.loadDocIndex();
    index[path] = {
      id: documentId,
      contentHash: await sha256Text(content),
      size: content.length,
      mtime: Date.now(),
      ...(frontiers ? { frontiers } : {}),
    };
    this.indexTouchesThisPass?.add(path);
    await this.saveDocIndex(index);
  }

  /**
   * True when a document's file on disk no longer matches what this engine
   * last wrote or ingested there — an external edit that hasn't been
   * ingested yet. Anything about to rewrite that file (a client's save on
   * the server) must ingest first, or the external edit is overwritten.
   */
  async hasPendingExternalEdit(documentId: string): Promise<boolean> {
    const node = this.tree.findByDocumentId(documentId);
    const path = this.materializedPaths.get(documentId) ?? (node ? buildPathFromNode(this.tree, node) : null);
    return path ? this.externalEditPendingAt(path) : false;
  }

  /**
   * True when the file at `path` differs from what the index says this
   * engine last wrote there (and, if given, from `aboutToWrite`). Writing
   * over it would destroy an external edit the watcher hasn't ingested yet.
   * No index entry means the engine never wrote the path: nothing to
   * protect.
   */
  private async externalEditPendingAt(path: string, aboutToWrite?: string): Promise<boolean> {
    const entry = (await this.loadDocIndex())[path];
    if (!entry) return false;
    const bytes = await this.docStore.readMaterialized(path);
    if (!bytes) return false;
    const raw = new TextDecoder().decode(bytes);
    const content = extractIdFromMarkdown(raw) ? stripIdComment(raw) : raw;
    if (aboutToWrite !== undefined && content === aboutToWrite) return false;
    return (await sha256Text(content)) !== entry.contentHash;
  }

  /**
   * Called instead of a Markdown write whose target holds an un-ingested
   * external edit. The file, checkpoint and index are left alone so the
   * next ingest pass sees the edit and three-way merges it.
   */
  private async deferWriteForExternalEdit(documentId: string, path: string): Promise<void> {
    console.warn(
      `[VaultEngine] not writing "${path}": it was edited outside the app since the last ` +
        `write; leaving it for the external-change ingest to merge.`,
    );
    await this.diag("defer-write-external-edit", { detail: `${documentId} ${path}` });
  }

  /**
   * Drop the cached doc index so the next use re-reads the file. For a tab
   * that becomes the writer: another tab may have written the index since
   * this one read it.
   */
  forgetCachedDocIndex(): void {
    if (!this.docIndexWriteQueued) this.docIndexCache = null;
  }

  /** Mirror of touchIndexEntry for the app's own deletions/moves-away. */
  private async dropIndexEntry(path: string): Promise<void> {
    const index = await this.loadDocIndex();
    if (path in index) {
      delete index[path];
      await this.saveDocIndex(index);
    }
  }

  /**
   * Ingest external filesystem changes into the CRDT/tree (SPEC §5, §25,
   * §26): scans materialised `.md` files, reconciles them against the
   * sidecar doc index via `reconcileVault()`, and applies the result:
   *
   *   - known path, content changed        -> three-way merge into LoroText
   *   - moved (missing indexed path match) -> tree move/rename, id kept
   *   - copied (still-present path match)  -> new document, fresh id
   *   - genuinely new file                 -> new document
   *   - indexed path gone, unclaimed       -> deleteDocument
   *
   * Must run BEFORE any pass that treats disk as *output* (materializing
   * "stale" docs, deleting "orphan" files) — see reconcileMaterialization,
   * which calls this first. Otherwise an external edit would be silently
   * overwritten and a new external file would be deleted as an "orphan"
   * rather than adopted.
   *
   * One guard against a false positive: a file whose content matches an
   * already tree-tracked, loaded document that was never actually written
   * to disk at *this* path is NOT adopted as a second "new" document —
   * that's the ordinary materialize-lag case (a doc created this session,
   * or a rename/move interrupted by a crash before the old file was
   * cleaned up), not an external contribution. It's left for
   * reconcileMaterialization's expected-path pass, which re-derives
   * placement from the tree (the authority while the app is running) and
   * GCs the leftover.
   */
  /**
   * Passes never overlap: startup's background reconcile, the browser's
   * visibility check and the server's watcher can all ask for one.
   */
  ingestExternalChanges(): Promise<IngestReport> {
    const run = this.ingestChain.then(() => this.ingestExternalChangesNow());
    this.ingestChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private ingestChain: Promise<void> = Promise.resolve();

  private async ingestExternalChangesNow(): Promise<IngestReport> {
    // Comparing disk with documents that aren't loaded yet would read as
    // edits and deletions that never happened.
    await this.allDocumentsLoaded;
    const empty: IngestReport = {
      edited: [],
      moved: [],
      copied: [],
      created: [],
      deleted: [],
    };

    const trackedBefore = this.tree.documentIds().length;
    // A copy: entries written while this pass applies its results must not
    // change the baseline it compares against.
    const prevIndex = { ...(await this.loadDocIndex()) };
    let diskPaths = (await this.docStore.listMaterializedPaths()).filter(
      (p) => isMarkdownPath(p) && !isIgnoredExternalPath(p),
    );

    // Safety rail #1: never treat "the disk scan came back empty" as "the
    // user deleted everything" — not even for a single-document vault. A
    // transient read glitch (an OPFS walk() race, a storage hiccup, a
    // listing call against a not-yet-ready handle) must not be
    // indistinguishable from a real deletion. This is the exact failure
    // mode that wiped a real vault: an empty scan combined with an
    // unconditional persistTree()/saveDocIndex() at the end permanently
    // overwrote a good tree snapshot with an empty one.
    //
    // Applies whenever we have something to lose (tracked docs and/or a
    // non-empty index) — verified by re-scanning once rather than trusting
    // a single read. A genuinely empty vault (both scans agree) still
    // proceeds normally, including the legitimate "deleted my one and only
    // note" case; only a scan that disagrees with itself is refused.
    const hasSomethingToLose = trackedBefore >= 1 || Object.keys(prevIndex).length > 0;
    if (diskPaths.length === 0 && hasSomethingToLose) {
      const recheck = (await this.docStore.listMaterializedPaths()).filter(
        (p) => isMarkdownPath(p) && !isIgnoredExternalPath(p),
      );
      if (recheck.length > 0) {
        console.warn(
          `[VaultEngine] ingestExternalChanges: disk scan returned 0 markdown ` +
            `files but a re-scan found ${recheck.length} — treating the first ` +
            `scan as a transient read glitch and refusing to ingest this pass.`,
        );
        await this.diag("refuse-empty-scan", {
          counts: { trackedBefore, recheckFiles: recheck.length },
        });
        return empty;
      }
      diskPaths = recheck; // both scans agree: []
    }

    const files: FileSnapshot[] = [];
    for (const path of diskPaths) {
      const bytes = await this.docStore.readMaterialized(path);
      if (bytes) files.push({ path, content: new TextDecoder().decode(bytes) });
    }

    const liveHashes = new Map<string, string>();
    for (const [id, doc] of this.documents) {
      if (!this.tree.findByDocumentId(id)) continue;
      liveHashes.set(await sha256Text(doc.getMarkdown()), id);
    }

    const result = await reconcileVault(prevIndex, files);
    const report: IngestReport = {
      edited: [],
      moved: [],
      copied: [],
      created: [],
      deleted: [],
    };
    const finalIndex: DocIndex = {};

    // Safety rail #2: refuse a mass deletion in one pass. A handful of
    // real external deletes is normal; more than half of everything we
    // know about disappearing at once (or all of it) is far more likely a
    // bad/partial disk scan than a deliberate bulk delete — log and skip
    // the deletions entirely (the rest of the ingest — edits/moves/new
    // files — still proceeds; nothing about those is destructive).
    const knownDocCount = Math.max(trackedBefore, Object.keys(prevIndex).length);
    const massDeletionThreshold = Math.max(1, Math.ceil(knownDocCount * 0.5));
    const deletionsRefused = knownDocCount > 0 && result.deletedPaths.length >= massDeletionThreshold
      && result.deletedPaths.length > 0
      && knownDocCount > 1; // a single-doc vault losing its one doc isn't "mass"
    if (deletionsRefused) {
      console.warn(
        `[VaultEngine] ingestExternalChanges: refusing to delete ` +
          `${result.deletedPaths.length}/${knownDocCount} tracked document(s) ` +
          `in one pass (over the mass-deletion threshold) — skipping all ` +
          `deletions this run. Delete them individually via the app if this ` +
          `is intentional.`,
      );
      await this.diag("refuse-mass-deletion", {
        counts: { attempted: result.deletedPaths.length, known: knownDocCount },
      });
    }

    // Deletions: an indexed path disappeared and wasn't claimed by a move.
    if (!deletionsRefused) {
      for (const path of result.deletedPaths) {
        const entry = prevIndex[path];
        if (!entry) continue;
        const node = this.tree.findByDocumentId(entry.id);
        if (node) {
          this.tree.delete(node.treeId);
          this.documents.delete(entry.id);
          this.materializedPaths.delete(entry.id);
          report.deleted.push(entry.id);
          await this.diag("ingest-delete", { detail: `${entry.id} ${path}` });
        }
      }
    }

    this.indexTouchesThisPass = new Set();
    // The index file is written once, with the final index, at the end.
    this.deferDocIndexWrites = true;
    try {
    for (const r of result.resolved) {
      const entryHash = result.index[r.path]!.contentHash;

      if (r.kind === "new" && liveHashes.has(entryHash)) {
        // Materialize-lag false positive — see doc comment above.
        continue;
      }

      const segments = r.path.split("/");
      const fileName = segments.pop()!;

      if (r.kind === "known") {
        const prevEntry = prevIndex[r.path];
        const changed = !prevEntry || prevEntry.contentHash !== entryHash;
        // Even when the content itself is unchanged, a lingering legacy
        // `adhd:id` comment (r.rewrite) still needs writing back clean —
        // otherwise a migrated-but-untouched file never gets its one-time
        // cleanup materialised to disk.
        if (changed || r.rewrite) {
          const doc = this.documents.get(r.id);
          if (doc) {
            // This pass consumes the file's current disk content, so record
            // it as seen: the write-back below must not be deferred as an
            // un-ingested external edit.
            await this.touchIndexEntry(r.path, r.id, r.cleanContent);
            const state = await this.docStore.readState(r.id);
            const currentContent = doc.getText(CONTENT_KEY).toString();
            if (!r.rewrite && r.cleanContent === currentContent) {
              // The file already says what the CRDT says: the app wrote it
              // and its index update never landed (e.g. the tab closed
              // first). Nothing to merge — merging would only churn history.
              await this.touchIndexEntry(r.path, r.id, currentContent, doc.doc.oplogFrontiers());
              finalIndex[r.path] = result.index[r.path]!;
              continue;
            }

            // Safety rail: never let an "external edit" that shrinks or
            // empties content win over CRDT changes newer than the index
            // entry. `prevEntry.contentHash` is what the CRDT looked like
            // the last time this path was actually written/indexed by the
            // app; if the CRDT's *current* content no longer matches that
            // hash, there's a local edit the index doesn't know about yet
            // (un-materialized). Combined with the incoming disk content
            // being shorter/emptier than what's currently in the CRDT,
            // this "edit" is far more likely a race (a stale/partial write
            // losing to — or arriving before — the real content, or a scan
            // catching a file mid-write) than a deliberate external
            // shrink. Keep the CRDT's content; log and skip the merge.
            const currentHash = await sha256Text(currentContent);
            const hasUnindexedChanges = !prevEntry || prevEntry.contentHash !== currentHash;
            // "Shrink" is measured against what was last written to disk (the
            // merge base), not against the CRDT: the CRDT may hold newer
            // changes (a client's edit) that make it longer than a disk edit
            // which itself only *added* text. The three-way merge keeps the
            // CRDT's own changes either way; the rail only guards against a
            // file that lost content since the app last wrote it.
            const baseLength = prevEntry?.size ?? currentContent.length;
            const wouldShrinkOrEmpty =
              currentContent.length > 0 && r.cleanContent.length < baseLength;

            if (changed && hasUnindexedChanges && wouldShrinkOrEmpty) {
              console.warn(
                `[VaultEngine] ingestExternalChanges: refusing to shrink/empty ` +
                  `document ${r.id} at "${r.path}" (disk has ${r.cleanContent.length} ` +
                  `chars, CRDT has ${currentContent.length} un-materialized-newer chars) ` +
                  `— keeping the CRDT's content and re-materializing it instead.`,
              );
              // Disk is now wrong relative to the CRDT we're keeping —
              // write the CRDT's real content back rather than leaving a
              // stale/conflicting file sitting there.
              await this.persistDocumentIncremental(r.id);
            } else {
              const checkpoint: MaterializationCheckpoint = {
                documentId: r.id,
                // The version last written to this path is the true merge
                // base; the persisted state's frontiers can be newer than
                // what's on disk (it tracks compaction, not writes).
                frontiers: prevEntry?.frontiers ?? state?.frontiers ?? doc.frontiers(),
                sha256: state?.sha256 ?? "",
              };
              mergeExternalEdit(doc.doc, checkpoint, r.cleanContent);
              this.materializedPaths.set(r.id, r.path);
              await this.persistDocumentIncremental(r.id);
              report.edited.push(r.id);
            }
          }
        }
      } else if (r.kind === "move") {
        const node = this.tree.findByDocumentId(r.id);
        if (node) {
          const parent = this.ensureFolderPath(segments);
          this.tree.move(node.treeId, parent);
          if (node.name !== fileName) this.tree.rename(node.treeId, fileName);
          this.materializedPaths.set(r.id, r.path);
          if (r.rewrite) {
            const doc = this.documents.get(r.id);
            if (doc && doc.getMarkdown() !== r.cleanContent) {
              doc.setText(r.cleanContent);
              await this.persistDocumentIncremental(r.id);
            }
          }
          report.moved.push(r.id);
        }
      } else if (!this.documents.has(r.id)) {
        // "copy" or "new": a document we don't yet track under this id.
        const parent = this.ensureFolderPath(segments);
        const doc = Document.fromMarkdown(r.id, r.cleanContent);
        this.tree.addMarkdownDocument(parent, fileName, r.id);
        this.setDocument(r.id, doc);
        this.materializedPaths.set(r.id, r.path);
        await this.persistDocumentIncremental(r.id);
        (r.kind === "copy" ? report.copied : report.created).push(r.id);
      }

      finalIndex[r.path] = result.index[r.path]!;
    }

    } finally {
      this.deferDocIndexWrites = false;
    }

    // Paths this pass wrote back (merged content, re-materialised CRDT)
    // already have a current entry, with the version written; the scan's
    // entry describes the file as it was *before* those writes.
    const touched = this.indexTouchesThisPass;
    this.indexTouchesThisPass = null;
    if (touched && touched.size > 0) {
      const current = await this.loadDocIndex();
      for (const path of touched) {
        if (path in finalIndex && current[path]?.id === finalIndex[path]!.id) finalIndex[path] = current[path]!;
      }
    }

    await this.persistTree();
    await this.saveDocIndex(finalIndex);
    if (
      report.edited.length > 0 ||
      report.moved.length > 0 ||
      report.copied.length > 0 ||
      report.created.length > 0 ||
      report.deleted.length > 0
    ) {
      await this.refreshIndexes();
    }
    return report;
  }

  /** Find or create the folder chain for `segments`, returning its final TreeID. */
  private ensureFolderPath(segments: string[], created?: string[]): TreeID | undefined {
    let parent: TreeID | undefined;
    let path = "";
    for (const seg of segments) {
      if (!seg) continue;
      path = path ? `${path}/${seg}` : seg;
      const siblings = parent ? this.tree.children(parent) : this.tree.roots();
      const existing = siblings.find(
        (n) => n.kind === "directory" && n.name.toLowerCase() === seg.toLowerCase(),
      );
      if (existing) {
        parent = existing.treeId;
      } else {
        parent = this.tree.addDirectory(parent, seg);
        created?.push(path);
      }
    }
    return parent;
  }

  /**
   * Boot-time (and on-demand) reconciliation so the on-disk vault tree
   * always mirrors the CRDT tree + content:
   *   - ingest external changes first (see ingestExternalChanges) so an
   *     external edit/move/copy/new-file/delete is absorbed rather than
   *     clobbered by the passes below
   *   - re-materialise any tracked doc whose file is missing or stale
   *   - delete any stale materialised `.md` that no longer corresponds to a
   *     tree node (stale path left behind by a rename/move that happened
   *     before this session, e.g. across a crash) — unknown ordinary files
   *     are adopted as binary nodes or preserved, and `.methyl` is never touched
   */
  /**
   * Resolve any post-merge same-name sibling collisions (VaultTree.
   * resolveNameCollisions()) and re-materialise every markdown document
   * that got renamed, so its on-disk file moves to the new deterministic
   * path (and the old, now-wrong path is removed) rather than leaving a
   * stale file behind under the pre-collision name. Call this after
   * anything that can merge in a foreign tree state — a sync round, or an
   * imported tree update — and before relying on buildPathFromNode() for
   * any of the affected documents.
   */
  async resolveTreeNameCollisions(): Promise<string[]> {
    const renamedTreeIds = this.tree.resolveNameCollisions();
    if (renamedTreeIds.length === 0) return [];
    for (const treeId of renamedTreeIds) {
      const node = this.tree.getNode(treeId);
      if (!node || node.kind !== "markdown" || !node.documentId) continue;
      if (!this.documents.has(node.documentId)) continue; // content not loaded here yet — a later sync round will materialize it at its (now-correct) path
      await this.materializeToTreePath(node.documentId);
    }
    return renamedTreeIds.map((id) => String(id));
  }

  async reconcileMaterialization(): Promise<{
    ingested: IngestReport;
    materialized: string[];
    removed: string[];
  }> {
    await this.allDocumentsLoaded;
    await this.resolveTreeNameCollisions();
    const folders = await this.ingestExternalFolders();
    const ingested = await this.ingestExternalChanges();
    if (folders.created.length > 0) ingested.foldersCreated = folders.created;
    const assets = await this.ingestExternalAssets();
    if (assets.created.length > 0) ingested.assetsCreated = assets.created;
    if (assets.updated.length > 0) ingested.assetsUpdated = assets.updated;

    const materialized: string[] = [];
    // The ingest above has just compared every file with the index, so the
    // index now describes the disk: a document is stale when its content
    // differs from its index entry. No need to read and hash every file a
    // second time.
    const index = await this.loadDocIndex();
    const onDisk = new Set(await this.docStore.listMaterializedPaths());
    for (const node of this.tree.allNodes()) {
      const path = buildPathFromNode(this.tree, node);
      if (!path) continue;
      if (node.kind === "binary") {
        this.materializedAssetPaths.set(String(node.treeId), path);
        continue;
      }
      if (node.kind !== "markdown" || !node.documentId) continue;
      const doc = this.documents.get(node.documentId);
      if (!doc) continue;
      const entry = index[path];
      const stale =
        !entry ||
        entry.id !== node.documentId ||
        !onDisk.has(path) ||
        entry.contentHash !== (await sha256Text(doc.getText(CONTENT_KEY).toString()));
      if (stale) {
        const cp = await this.materializeDocument(node.documentId, path);
        if (cp) materialized.push(path);
      } else {
        this.materializedPaths.set(node.documentId, path);
      }
    }

    // What the tree expects on disk, computed *now*: reconcile can run in
    // the background while the app is in use, and a note created meanwhile
    // must not be swept away as an orphan.
    const expected = new Set<string>();
    for (const node of this.tree.allNodes()) {
      if (node.kind !== "binary" && !(node.kind === "markdown" && node.documentId)) continue;
      const path = buildPathFromNode(this.tree, node);
      if (path) expected.add(path);
    }

    const removed: string[] = [];
    for (const path of await this.docStore.listMaterializedPaths()) {
      if (path.endsWith(".tmp")) continue;
      if (!expected.has(path)) {
        // Markdown paths are safe to garbage-collect only after the
        // document ingest pass has established that they are stale. Unknown
        // ordinary files are user data (and may be attachments from another
        // tool), so preserve them until the attachment reconciler adopts or
        // explicitly removes them.
        if (isMarkdownPath(path)) {
          await this.materializedRemove(path);
          removed.push(path);
        } else {
          await this.diag("preserve-unknown-materialized-file", { detail: path });
        }
      }
    }
    if (removed.length > 0) {
      await this.diag("orphan-sweep", {
        counts: { removed: removed.length },
        detail: removed.slice(0, 10).join(","),
      });
    }
    return { ingested, materialized, removed };
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
    const currentContent = doc.getText(CONTENT_KEY).toString();
    const mdBytes = new TextEncoder().encode(currentContent);
    await this.materializedWrite(filePath, mdBytes);
    this.materializedPaths.set(documentId, filePath);
    const frontiers = doc.doc.oplogFrontiers();
    await this.touchIndexEntry(filePath, documentId, currentContent, frontiers);
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
    await this.updateIndexesForDocument(documentId);
    return checkpoint;
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

  private setDocument(documentId: string, document: Document): void {
    this.documents.set(documentId, document);
    const listeners = this.documentAvailableListeners.get(documentId);
    if (!listeners) return;
    this.documentAvailableListeners.delete(documentId);
    for (const listener of listeners) listener();
  }

  /**
   * Persist a new commit as an incremental update segment; compact when
   * thresholds are breached (§10). Returns whether compaction ran.
   * Call this after every local edit-commit; never touch binary bytes yourself.
   */
  /**
   * Persists of one document run one at a time. Two overlapping persists
   * could otherwise interleave so that one's compaction deletes the update
   * segment the other appended after that compaction's snapshot was taken.
   */
  persistDocumentIncremental(
    documentId: string,
    rules: CompactionRules = DEFAULT_COMPACTION_RULES,
  ): Promise<{ compacted: boolean }> {
    const previous = this.persistChains.get(documentId) ?? Promise.resolve();
    const run = previous.then(() => this.persistDocumentNow(documentId, rules));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.persistChains.set(documentId, settled);
    void settled.then(() => {
      if (this.persistChains.get(documentId) === settled) this.persistChains.delete(documentId);
    });
    return run;
  }

  private persistChains = new Map<string, Promise<void>>();

  private async persistDocumentNow(
    documentId: string,
    rules: CompactionRules,
  ): Promise<{ compacted: boolean }> {
    // Never write a document's file from a copy missing its stored state.
    await this.loadStoredDocument(documentId);
    const doc = this.documents.get(documentId);
    if (!doc) throw new Error(`Document not found: ${documentId}`);
    doc.doc.commit();
    const update = doc.doc.export({ mode: "update" });
    await this.docStore.appendUpdate(documentId, update);

    // Keep the on-disk .md mirror current. The editor already debounces
    // calls into this method (session flush), so this isn't per-keystroke.
    // A deferred write (external edit pending on disk) must not compact:
    // compaction advances the stored frontiers the ingest merges against.
    if (!(await this.materializeToTreePath(documentId))) return { compacted: false };

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
    // Moves and removes files of every document it touches.
    await this.allDocumentsLoaded;
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
    // Moves and removes files of every document it touches.
    await this.allDocumentsLoaded;
    const node = this.tree.findByDocumentId(documentId);
    if (!node) throw new Error(`Document not tracked in tree: ${documentId}`);
    const oldPath = this.materializedPaths.get(documentId) ?? buildPathFromNode(this.tree, node);
    this.tree.delete(node.treeId);
    this.documents.delete(documentId);
    this.materializedPaths.delete(documentId);
    await this.persistTree();
    if (oldPath) {
      await this.materializedRemove(oldPath);
      await this.dropIndexEntry(oldPath);
    }
    await this.updateIndexesForDocument(documentId);
    await this.diag("delete-document", { detail: `${documentId} ${oldPath ?? ""}`.trim() });
  }

  /**
   * After a tree change merged in from sync, make the files on disk follow
   * the tree: remove the file of a note the tree no longer has, and move
   * the file of a note that was renamed or moved. Without this they only
   * caught up at the next boot's reconcile. A file holding an external edit
   * that hasn't been ingested is left alone for the ingest to handle.
   */
  async applyTreeToDisk(): Promise<{ removed: string[]; moved: string[] }> {
    await this.allDocumentsLoaded;
    const removed: string[] = [];
    const moved: string[] = [];
    const live = new Set(this.tree.documentIds());
    for (const [documentId, path] of [...this.materializedPaths]) {
      if (live.has(documentId)) continue;
      if (await this.externalEditPendingAt(path)) {
        await this.deferWriteForExternalEdit(documentId, path);
        continue;
      }
      await this.materializedRemove(path);
      await this.dropIndexEntry(path);
      this.materializedPaths.delete(documentId);
      this.documents.delete(documentId);
      await this.updateIndexesForDocument(documentId);
      removed.push(path);
    }
    for (const documentId of live) {
      if (!this.documents.has(documentId)) continue;
      const node = this.tree.findByDocumentId(documentId);
      const path = node ? buildPathFromNode(this.tree, node) : null;
      const current = this.materializedPaths.get(documentId);
      if (!path || !current || current === path) continue;
      if (await this.materializeToTreePath(documentId)) moved.push(path);
    }
    if (removed.length > 0 || moved.length > 0) {
      await this.diag("apply-tree-to-disk", {
        counts: { removed: removed.length, moved: moved.length },
        detail: [...removed, ...moved].slice(0, 10).join(","),
      });
    }
    return { removed, moved };
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
    await this.allDocumentsLoaded;
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
    // Moves and removes files of every document it touches.
    await this.allDocumentsLoaded;
    this.tree.rename(treeId, newName);
    await this.rematerializeSubtree(treeId);
  }

  /** Re-write the `.md` mirror (old path -> new path) for a note or every note under a folder. */
  private async rematerializeSubtree(treeId: TreeID): Promise<void> {
    const node = this.tree.getNode(treeId);
    if (!node) return;
    if (node.kind === "binary") {
      await this.rematerializeAsset(node.treeId, node);
      return;
    }
    if (node.kind === "markdown" && node.documentId) {
      await this.materializeToTreePath(node.documentId);
      return;
    }
    if (node.kind === "directory") {
      for (const docId of collectDocumentIds(this.tree, treeId)) {
        await this.materializeToTreePath(docId);
      }
      for (const asset of collectBinaryNodes(this.tree, treeId)) {
        await this.rematerializeAsset(asset.treeId, asset);
      }
    }
  }

  private async rematerializeAsset(treeId: TreeID, node: VaultTreeNode): Promise<void> {
    const newPath = buildPathFromNode(this.tree, node);
    if (!newPath) return;
    const key = String(treeId);
    const oldPath = this.materializedAssetPaths.get(key);
    const bytes = await this.docStore.readMaterialized(oldPath ?? newPath);
    if (bytes) await this.materializedWrite(newPath, bytes);
    if (oldPath && oldPath !== newPath) await this.materializedRemove(oldPath);
    this.materializedAssetPaths.set(key, newPath);
  }

  /**
   * Delete a folder and everything beneath it. Removes any contained
   * documents from the in-memory map as well as the tree (mirrors
   * deleteDocument's semantics: persisted CRDT bytes are left in place for
   * recovery/GC, only the tree pointer is removed).
   */
  async deleteFolder(treeId: TreeID): Promise<void> {
    // Moves and removes files of every document it touches.
    await this.allDocumentsLoaded;
    const node = this.tree.getNode(treeId);
    if (!node) throw new Error(`Node not found: ${treeId}`);
    const docIds = collectDocumentIds(this.tree, treeId);
    const assetNodes = collectBinaryNodes(this.tree, treeId);
    const oldPaths: string[] = [];
    for (const docId of docIds) {
      const path = this.materializedPaths.get(docId);
      if (path) oldPaths.push(path);
      this.documents.delete(docId);
      this.materializedPaths.delete(docId);
    }
    const oldAssetPaths = assetNodes
      .map((asset) => this.materializedAssetPaths.get(String(asset.treeId)) ?? buildPathFromNode(this.tree, asset))
      .filter((path): path is string => path !== null);
    for (const asset of assetNodes) this.materializedAssetPaths.delete(String(asset.treeId));
    this.tree.delete(treeId);
    await this.persistTree();
    for (const path of oldPaths) {
      await this.materializedRemove(path);
      await this.dropIndexEntry(path);
    }
    for (const path of oldAssetPaths) await this.materializedRemove(path);
    await this.refreshIndexes();
    await this.diag("delete-folder", {
      counts: { docs: docIds.length, assets: assetNodes.length },
      detail: `${treeId} ${oldPaths.slice(0, 10).join(",")}`,
    });
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

function collectBinaryNodes(tree: VaultTree, rootTreeId: TreeID): VaultTreeNode[] {
  const nodes: VaultTreeNode[] = [];
  const visit = (treeId: TreeID) => {
    const node = tree.getNode(treeId);
    if (node?.kind === "binary") nodes.push(node);
    for (const child of tree.children(treeId)) visit(child.treeId);
  };
  visit(rootTreeId);
  return nodes;
}

/**
 * Post-merge sibling name collisions (two peers, offline, each
 * independently creating a same-named node before ever syncing — nothing
 * in the tree CRDT rejects that) are resolved as a *real* CRDT tree edit —
 * see VaultTree.resolveNameCollisions() — not computed virtually here at
 * materialize time. An earlier version of this function computed a
 * collision-free name on the fly, per call, from the current sibling set;
 * that's unsound: it was recomputed independently every time any sibling
 * in the group got (re-)materialized, at whatever moment that happened to
 * run, so two calls for the same group could each pick a different
 * "winner" depending on what else existed in the tree yet — silently
 * overwriting an already-written file when the winner changed between
 * calls. A one-time, real rename that propagates through normal tree sync
 * doesn't have that failure mode: once resolved, every replica's tree
 * (and therefore every future buildPathFromNode call) agrees for good.
 * Callers that just merged/imported tree updates must call
 * VaultEngine.resolveTreeNameCollisions() before relying on paths from
 * this function.
 */
export function buildPathFromNode(
  tree: VaultTree,
  node: VaultTreeNode,
): string | null {
  const parts: string[] = [];
  let current = tree.tree.getNodeByID(node.treeId);
  while (current) {
    const rawName = (current.data.get("name") as string) || "";
    const parent = current.parent();
    parts.unshift(rawName);
    current = parent ?? undefined;
  }
  return parts.join("/");
}
