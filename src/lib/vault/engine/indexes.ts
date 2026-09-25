import { parseMarkdown } from "@/lib/core/markdown";
import type { DocIndexEntry } from "@/lib/core/types";
import { type BacklinkEntry, type IndexedDocument, toIndexedDocument } from "@/lib/search/index";
import type { VaultEngine } from "@/lib/vault/engine";
import {
  buildPathFromNode,
  INDEX_PERSIST_DEBOUNCE_MS,
  skipCachePersist,
} from "@/lib/vault/engine/helpers";

/**
 * Search, backlink and graph indexes: built lazily, kept current
 * incrementally, written debounced (spec item 20).
 */

/** Search note titles and Markdown content with MiniSearch ranking. */
export function search(engine: VaultEngine, query: string, limit = 50): DocIndexEntry[] {
  engine.rebuildSearchIfStale();
  return engine.searchIndex.search(query, limit);
}

/** Return notes that contain a wikilink targeting this document. */
export function backlinksFor(engine: VaultEngine, documentId: string): BacklinkEntry[] {
  engine.recomputeDerivedIfStale();
  return engine.derivedIndexes.backlinksFor(documentId);
}

export function indexedDocument(engine: VaultEngine, documentId: string): IndexedDocument | null {
  const node = engine.tree.findByDocumentId(documentId);
  const doc = engine.documents.get(documentId);
  if (!node || node.kind !== "markdown" || !node.documentId || !doc) return null;
  const path = buildPathFromNode(engine.tree, node);
  if (!path) return null;
  doc.doc.commit();
  return toIndexedDocument(parseMarkdown(doc.getMarkdown(), path), path, documentId);
}

export function allIndexedDocuments(engine: VaultEngine): IndexedDocument[] {
  return engine.tree
    .allNodes()
    .filter((node) => node.kind === "markdown" && Boolean(node.documentId))
    .map((node) => engine.indexedDocument(node.documentId!))
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
export async function initializeIndexes(engine: VaultEngine): Promise<void> {
  engine.searchStale = true;
  engine.derivedStale = true;
  engine.searchIndexReady = true;
}

export function rebuildSearchIfStale(engine: VaultEngine): void {
  if (!engine.searchStale) return;
  engine.searchStale = false;
  engine.searchIndex.replaceAll(engine.allIndexedDocuments());
}

/**
 * The search, backlink and graph caches are derived (SPEC §3) and only
 * read at the next startup, so their writes are debounced: a burst of
 * changes (a sync round, an import) writes them once, not once per note.
 * The in-memory indexes are always current. Resolves once the write that
 * includes this change has finished.
 */
export function queueIndexPersist(engine: VaultEngine): Promise<void> {
  const done = new Promise<void>((resolve) => engine.indexPersistWaiters.push(resolve));
  if (engine.indexPersistTimer) clearTimeout(engine.indexPersistTimer);
  engine.indexPersistTimer = setTimeout(() => void engine.flushIndexes(), INDEX_PERSIST_DEBOUNCE_MS);
  (engine.indexPersistTimer as { unref?: () => void }).unref?.();
  return done;
}

/** Write the derived caches now if a write is pending. */
export async function flushIndexes(engine: VaultEngine): Promise<void> {
  if (engine.indexPersistTimer) {
    clearTimeout(engine.indexPersistTimer);
    engine.indexPersistTimer = null;
  }
  const waiters = engine.indexPersistWaiters.splice(0);
  if (waiters.length === 0) return engine.indexPersistChain;
  engine.indexPersistChain = engine.indexPersistChain
    .then(async () => {
      await engine.allDocumentsLoaded;
      engine.rebuildSearchIfStale();
      await engine.searchIndex.persist();
      engine.derivedStale = false;
      await engine.derivedIndexes.build(engine.allIndexedDocuments());
    })
    .catch((error) => skipCachePersist(error))
    .finally(() => waiters.forEach((resolve) => resolve()));
  return engine.indexPersistChain;
}

export function recomputeDerivedIfStale(engine: VaultEngine): void {
  if (!engine.derivedStale) return;
  engine.derivedStale = false;
  engine.derivedIndexes.compute(engine.allIndexedDocuments());
}

export function indexSearchDocument(engine: VaultEngine, documentId: string): void {
  // A pending full rebuild will pick this document up.
  if (engine.searchStale) return;
  const indexed = engine.indexedDocument(documentId);
  if (indexed) engine.searchIndex.add(indexed);
  else engine.searchIndex.remove(documentId);
}

export async function updateIndexesForDocument(engine: VaultEngine, documentId: string): Promise<void> {
  if (!engine.searchIndexReady) return;
  engine.indexSearchDocument(documentId);
  engine.derivedStale = true;
  void engine.queueIndexPersist();
}

export async function refreshIndexes(engine: VaultEngine): Promise<void> {
  if (!engine.searchIndexReady) return;
  engine.searchStale = true;
  engine.derivedStale = true;
  void engine.queueIndexPersist();
}
