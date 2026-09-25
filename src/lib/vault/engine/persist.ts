import { Document } from "@/lib/core/document";
import { type CompactionRules, DEFAULT_COMPACTION_RULES, shouldCompact } from "@/lib/vault/compact";
import type { VaultEngine } from "@/lib/vault/engine";
import { buildPathFromNode } from "@/lib/vault/engine/helpers";

/**
 * CRDT persistence (SPEC §10): loading stored state, and incremental update
 * segments compacted into a snapshot past the thresholds.
 */

/**
 * Read one document's stored state (snapshot + update segments) into memory,
 * once: concurrent callers share the load. Documents opened lazily (see
 * VaultEngine.open) are loaded by this on first use.
 */
export function loadStoredDocument(engine: VaultEngine, id: string): Promise<void> {
  const inFlight = engine.documentLoads.get(id);
  if (inFlight) return inFlight;
  if (!engine.unloadedIds.has(id)) return Promise.resolve();
  const load = (async () => {
    const snapshot = await engine.docStore.loadSnapshot(id);
    const updates = await engine.docStore.loadUpdates(id);
    engine.unloadedIds.delete(id);
    // Deleted while its bytes were being read: don't bring it back.
    const node = engine.tree.findByDocumentId(id);
    if (!node) return;
    // A sync may already have created the document (ensureDocument) and
    // merged remote changes into it; merge the stored state in too.
    const doc = engine.documents.get(id) ?? new Document(id);
    if (snapshot) doc.doc.import(snapshot);
    for (const update of updates) doc.doc.import(update);
    doc.doc.commit();

    // One-time migration: strip any legacy `adhd:id` comment still
    // living in previously-persisted LoroText (see
    // Document.migrateLegacyIdComment). This is a real CRDT edit, so
    // persist it immediately so it survives and syncs.
    if (doc.migrateLegacyIdComment()) {
      engine.migratedLegacyIds.push(id);
      try {
        await engine.docStore.appendUpdate(id, doc.doc.export({ mode: "update" }));
      } catch (error) {
        // A read-only tab may not write (§12); the writer tab migrates it.
        console.warn(`[VaultEngine] legacy-id migration of ${id} not persisted here`, error);
      }
    }

    // Derive the assumed on-disk path from the tree; reconcileMaterialization()
    // verifies this against reality (missing/stale files, orphaned paths).
    const assumedPath = buildPathFromNode(engine.tree, node);
    if (assumedPath && !engine.materializedPaths.has(id)) engine.materializedPaths.set(id, assumedPath);
    if (!engine.documents.has(id)) engine.setDocument(id, doc);
    else if (engine.searchIndexReady) engine.indexSearchDocument(id);
  })();
  engine.documentLoads.set(id, load);
  void load.finally(() => engine.documentLoads.delete(id)).catch(() => undefined);
  return load;
}

/**
 * Persist a new commit as an incremental update segment; compact when
 * thresholds are breached (§10). Returns whether compaction ran.
 * Call this after every local edit-commit; never touch binary bytes yourself.
 *
 * Persists of one document run one at a time. Two overlapping persists
 * could otherwise interleave so that one's compaction deletes the update
 * segment the other appended after that compaction's snapshot was taken.
 */
export function persistDocumentIncremental(
  engine: VaultEngine,
  documentId: string,
  rules: CompactionRules = DEFAULT_COMPACTION_RULES,
): Promise<{ compacted: boolean }> {
  const previous = engine.persistChains.get(documentId) ?? Promise.resolve();
  const run = previous.then(() => engine.persistDocumentNow(documentId, rules));
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  engine.persistChains.set(documentId, settled);
  void settled.then(() => {
    if (engine.persistChains.get(documentId) === settled) engine.persistChains.delete(documentId);
  });
  return run;
}

export async function persistDocumentNow(
  engine: VaultEngine,
  documentId: string,
  rules: CompactionRules,
): Promise<{ compacted: boolean }> {
  // Never write a document's file from a copy missing its stored state.
  await engine.loadStoredDocument(documentId);
  const doc = engine.documents.get(documentId);
  if (!doc) throw new Error(`Document not found: ${documentId}`);
  doc.doc.commit();
  const update = doc.doc.export({ mode: "update" });
  await engine.docStore.appendUpdate(documentId, update);

  // Keep the on-disk .md mirror current. The editor already debounces
  // calls into this method (session flush), so this isn't per-keystroke.
  // A deferred write (external edit pending on disk) must not compact:
  // compaction advances the stored frontiers the ingest merges against.
  if (!(await engine.materializeToTreePath(documentId))) return { compacted: false };

  const state = await engine.docStore.readState(documentId);
  if (!state) return { compacted: false };

  const now = Date.now();
  if (!shouldCompact(state, now, rules)) return { compacted: false };

  doc.doc.commit();
  const snapshot = doc.doc.export({ mode: "snapshot" });
  await engine.docStore.compact(documentId, snapshot, {
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
export async function persistTreeIncremental(
  engine: VaultEngine,
  rules: CompactionRules = DEFAULT_COMPACTION_RULES,
): Promise<{ compacted: boolean }> {
  engine.tree.doc.commit();
  const update = engine.tree.doc.export({ mode: "update" });
  await engine.treeStore.appendUpdate(update);

  const state = await engine.treeStore.readState();
  if (!state) return { compacted: false };

  const now = Date.now();
  if (!shouldCompact(state, now, rules)) return { compacted: false };

  engine.tree.doc.commit();
  const snapshot = engine.tree.doc.export({ mode: "snapshot" });
  await engine.treeStore.compact(snapshot, {
    frontiers: engine.tree.doc.oplogFrontiers(),
    compactedAt: now,
    lastUpdateAt: now,
    segments: 0,
    updateBytes: 0,
  });
  return { compacted: true };
}

/** Persist the vault tree via compact() (separate from doc persistence). */
export async function persistTree(engine: VaultEngine): Promise<void> {
  engine.tree.doc.commit();
  const snapshot = engine.tree.doc.export({ mode: "snapshot" });
  const frontiers = engine.tree.doc.oplogFrontiers();
  const now = Date.now();
  await engine.treeStore.compact(snapshot, {
    frontiers,
    compactedAt: now,
    lastUpdateAt: now,
    segments: 0,
    updateBytes: 0,
  });
}
