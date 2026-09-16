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
}

export class VaultEngine {
  readonly tree: VaultTree;
  readonly treeStore: VaultTreeStore;
  readonly docStore: PersistedDocStore;
  readonly vaultId: string;
  private documents = new Map<string, Document>();

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
      engine.documents.set(id, doc);
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
   * Create a new Markdown note in the vault tree.
   * The document ID is either extracted from `<!-- adhd:id=... -->` or generated.
   */
  createDocument(
    parentTreeId: TreeID | undefined,
    name: string,
    markdown: string,
  ): Document {
    const docId = Document.extractId(markdown) ?? crypto.randomUUID();
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

  /** Record a dirty room for tracking sync status. */
  async markDirty(documentId: string): Promise<DirtyRoom> {
    const doc = this.documents.get(documentId);
    if (!doc) throw new Error(`Document not found: ${documentId}`);
    return { roomId: `doc:${documentId}`, targetFrontiers: doc.frontiers() };
  }
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