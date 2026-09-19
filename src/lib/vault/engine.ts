import { LoroDoc, type OpId, type TreeID } from "loro-crdt";
import { VaultTree, type VaultTreeNode } from "@/lib/vault/tree";
import { Document, CONTENT_KEY } from "@/lib/core/document";
import type { PersistedDocStore, VaultTreeStore } from "@/lib/vault/store";
import type {
  DirtyRoom,
  DocIndexEntry,
  MaterializationCheckpoint,
  PersistedDocState,
} from "@/lib/core/types";
import { sha256Text } from "@/lib/core/hash";
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
}

/** Where the sidecar doc index (SPEC §5) lives, relative to the vault root. */
const DOC_INDEX_PATH = ".adhd/index.json";

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
   * directly. `.adhd/` is reserved for the app's own CRDT storage/index;
   * `sanitizeName` now blocks a tree node from being named `.adhd`, but
   * this is a second, independent check — a materialised path must never
   * touch that directory regardless of how it was computed, since OPFS's
   * `delete()` is recursive and a single wrong call there can destroy the
   * entire CRDT store in one shot. `DOC_INDEX_PATH` itself is the one
   * legitimate exception (it's the sidecar index file, deliberately
   * co-located with `.adhd/` so `listMaterializedPaths()` never lists it).
   */
  private isPathUnderReservedDir(path: string): boolean {
    if (path === DOC_INDEX_PATH) return false;
    return path === ".adhd" || path.startsWith(".adhd/");
  }

  /** Best-effort diagnostics append — never throws, never blocks the caller. */
  private async diag(op: string, options?: { counts?: Record<string, number>; detail?: string }): Promise<void> {
    await recordDiagnostic(this.docStore, op, options);
  }

  private async materializedWrite(path: string, bytes: Uint8Array): Promise<void> {
    if (this.isPathUnderReservedDir(path)) {
      console.error(
        `[VaultEngine] refusing to write materialised path "${path}" — ` +
          `it falls under the reserved .adhd/ metadata directory.`,
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
          `it falls under the reserved .adhd/ metadata directory.`,
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

    if (migratedLegacyIds.length > 0) {
      await engine.diag("legacy-id-migration", {
        counts: { migrated: migratedLegacyIds.length },
        detail: migratedLegacyIds.join(","),
      });
    }

    await engine.initializeIndexes();

    return { engine, recovery };
  }

  getDocument(id: string): Document | undefined {
    return this.documents.get(id);
  }

  listDocuments(): Document[] {
    return Array.from(this.documents.values());
  }

  /** Search note titles and Markdown content with MiniSearch ranking. */
  search(query: string, limit = 50): DocIndexEntry[] {
    return this.searchIndex.search(query, limit);
  }

  /** Return notes that contain a wikilink targeting this document. */
  backlinksFor(documentId: string): BacklinkEntry[] {
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

  private async initializeIndexes(): Promise<void> {
    // Load first so a corrupt/missing cache follows the same recovery path as
    // the standalone index APIs; current CRDT content always wins below.
    await Promise.all([this.searchIndex.load(), this.derivedIndexes.load()]);
    const documents = this.allIndexedDocuments();
    this.searchIndex.replaceAll(documents);
    await this.searchIndex.persist();
    await this.derivedIndexes.build(documents);
    this.searchIndexReady = true;
  }

  private queueIndexPersist(): Promise<void> {
    this.indexPersistChain = this.indexPersistChain
      .then(async () => {
        await this.searchIndex.persist();
        await this.derivedIndexes.build(this.allIndexedDocuments());
      })
      .catch((error) => console.error("[indexes] failed to persist derived indexes", error));
    return this.indexPersistChain;
  }

  private indexSearchDocument(documentId: string): void {
    const indexed = this.indexedDocument(documentId);
    if (indexed) this.searchIndex.add(indexed);
    else this.searchIndex.remove(documentId);
  }

  private async updateIndexesForDocument(documentId: string): Promise<void> {
    if (!this.searchIndexReady) return;
    this.indexSearchDocument(documentId);
    await this.queueIndexPersist();
  }

  private async refreshIndexes(): Promise<void> {
    if (!this.searchIndexReady) return;
    this.searchIndex.replaceAll(this.allIndexedDocuments());
    await this.queueIndexPersist();
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
    if (this.searchIndexReady) this.indexSearchDocument(docId);
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
    await this.touchIndexEntry(filePath, documentId, markdown);
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
    const content = doc.getText(CONTENT_KEY).toString();
    const bytes = new TextEncoder().encode(content);
    await this.materializedWrite(newPath, bytes);
    if (oldPath && oldPath !== newPath) {
      await this.materializedRemove(oldPath);
      await this.dropIndexEntry(oldPath);
    }
    this.materializedPaths.set(documentId, newPath);
    await this.touchIndexEntry(newPath, documentId, content);
    await this.updateIndexesForDocument(documentId);
  }

  /**
   * Load the sidecar doc index (SPEC §5/§26): relative path -> {id,
   * contentHash, size, mtime}, as of the last time the app itself wrote to
   * disk (materialize/remove). It is the "last written by app" marker that
   * lets ingestExternalChanges() tell an external edit/move/copy apart from
   * the app's own writes. Stored at `.adhd/index.json`, outside the
   * directories `listMaterializedPaths()` walks, so it's invisible to
   * normal vault listing.
   *
   * If absent (first run against an existing vault, or after deleting
   * `.adhd`), it's seeded from the current tree + whatever is already
   * materialised on disk, so that run treats the existing vault as the
   * known baseline rather than "everything is new".
   */
  async loadDocIndex(): Promise<DocIndex> {
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

  async saveDocIndex(index: DocIndex): Promise<void> {
    await this.docStore.writeMaterializedAtomic(
      DOC_INDEX_PATH,
      new TextEncoder().encode(JSON.stringify(index)),
    );
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
  ): Promise<void> {
    const index = await this.loadDocIndex();
    index[path] = {
      id: documentId,
      contentHash: await sha256Text(content),
      size: content.length,
      mtime: Date.now(),
    };
    await this.saveDocIndex(index);
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
  async ingestExternalChanges(): Promise<IngestReport> {
    const empty: IngestReport = {
      edited: [],
      moved: [],
      copied: [],
      created: [],
      deleted: [],
    };

    const trackedBefore = this.tree.documentIds().length;
    const prevIndex = await this.loadDocIndex();
    let diskPaths = (await this.docStore.listMaterializedPaths()).filter(
      (p) => p.endsWith(".md") && !p.endsWith(".tmp"),
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
        (p) => p.endsWith(".md") && !p.endsWith(".tmp"),
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
            const state = await this.docStore.readState(r.id);
            const currentContent = doc.getText(CONTENT_KEY).toString();

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
            const wouldShrinkOrEmpty =
              currentContent.length > 0 && r.cleanContent.length < currentContent.length;

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
                frontiers: state?.frontiers ?? doc.frontiers(),
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
        this.documents.set(r.id, doc);
        this.materializedPaths.set(r.id, r.path);
        await this.persistDocumentIncremental(r.id);
        (r.kind === "copy" ? report.copied : report.created).push(r.id);
      }

      finalIndex[r.path] = result.index[r.path]!;
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
  private ensureFolderPath(segments: string[]): TreeID | undefined {
    let parent: TreeID | undefined;
    for (const seg of segments) {
      if (!seg) continue;
      const siblings = parent ? this.tree.children(parent) : this.tree.roots();
      const existing = siblings.find((n) => n.kind === "directory" && n.name === seg);
      parent = existing ? existing.treeId : this.tree.addDirectory(parent, seg);
    }
    return parent;
  }

  /**
   * Boot-time (and on-demand) reconciliation so the on-disk `.md` tree
   * always mirrors the CRDT tree + content:
   *   - ingest external changes first (see ingestExternalChanges) so an
   *     external edit/move/copy/new-file/delete is absorbed rather than
   *     clobbered by the passes below
   *   - re-materialise any tracked doc whose file is missing or stale
   *   - delete any materialised `.md` that no longer corresponds to a tree
   *     node (stale path left behind by a rename/move that happened before
   *     this session, e.g. across a crash) — never touches `.adhd`
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
    await this.resolveTreeNameCollisions();
    const ingested = await this.ingestExternalChanges();

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
        await this.materializedRemove(path);
        removed.push(path);
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
    await this.touchIndexEntry(filePath, documentId, currentContent);
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
    await this.updateIndexesForDocument(documentId);
    return checkpoint;
  }

  /** Import a document update (from sync or external source). */
  async importDocumentUpdate(documentId: string, data: Uint8Array): Promise<void> {
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
      this.documents.set(documentId, doc);
    }
    return doc;
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
    if (oldPath) {
      await this.materializedRemove(oldPath);
      await this.dropIndexEntry(oldPath);
    }
    await this.updateIndexesForDocument(documentId);
    await this.diag("delete-document", { detail: `${documentId} ${oldPath ?? ""}`.trim() });
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
    for (const path of oldPaths) {
      await this.materializedRemove(path);
      await this.dropIndexEntry(path);
    }
    await this.refreshIndexes();
    await this.diag("delete-folder", {
      counts: { docs: docIds.length },
      detail: `${treeId} ${oldPaths.slice(0, 10).join(",")}`,
    });
  }
}

/** True if two Loro frontiers (OpId[]) denote the same version. */
function frontiersEqual(a: OpId[], b: OpId[]): boolean {
  if (a.length !== b.length) return false;
  const key = (f: OpId) => `${f.peer}:${f.counter}`;
  const bSet = new Set(b.map(key));
  return a.every((f) => bSet.has(key(f)));
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
