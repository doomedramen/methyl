import type { OpId } from "loro-crdt";
import { extractIdFromMarkdown, stripIdComment } from "@/lib/core/doc-id";
import type { DocIndex } from "@/lib/core/doc-index";
import { sha256Text } from "@/lib/core/hash";
import type { VaultEngine } from "@/lib/vault/engine";
import { buildPathFromNode, DOC_INDEX_PATH } from "@/lib/vault/engine/helpers";

/** The sidecar doc index (SPEC §5, §26): what the app last wrote or ingested at each path. */

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
export async function loadDocIndex(engine: VaultEngine): Promise<DocIndex> {
  // This engine is the index file's only writer, so after the first read
  // the in-memory copy is authoritative. Re-reading and re-parsing it on
  // every note write made bulk operations quadratic.
  if (engine.docIndexCache) return engine.docIndexCache;
  engine.docIndexCache = await engine.readDocIndexFromDisk();
  return engine.docIndexCache;
}

export async function readDocIndexFromDisk(engine: VaultEngine): Promise<DocIndex> {
  const bytes = await engine.docStore.readMaterialized(DOC_INDEX_PATH);
  if (!bytes) return engine.seedDocIndexFromTree();
  let parsed: DocIndex;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as DocIndex;
  } catch {
    return engine.seedDocIndexFromTree();
  }
  // Safety rail: an index that reads back as `{}` (or otherwise empty)
  // while the tree already tracks documents is not trustworthy ground
  // truth — it's either a fresh/never-populated index file or, worse,
  // exactly the aftermath of the bug this rail is closing (a bad ingest
  // pass wrote an empty index over a real one). Either way, an *empty*
  // index must never be read as "so every currently-tracked document is
  // an external deletion candidate" — reseed from what the tree actually
  // knows instead of trusting it blindly.
  if (Object.keys(parsed).length === 0 && engine.tree.documentIds().length > 0) {
    return engine.seedDocIndexFromTree();
  }
  return parsed;
}

/**
 * Replace the index and write it. Writes are coalesced: a save requested
 * while one is waiting shares that write, which always writes the newest
 * index. While an ingest pass is applying its results the file isn't
 * written at all until the pass saves its final index.
 */
export function saveDocIndex(engine: VaultEngine, index: DocIndex): Promise<void> {
  engine.docIndexCache = index;
  if (engine.deferDocIndexWrites) return Promise.resolve();
  if (engine.docIndexWriteQueued) return engine.docIndexWriteQueued;
  const next = engine.docIndexWriteChain.then(async () => {
    engine.docIndexWriteQueued = null;
    await engine.docStore.writeMaterializedAtomic(
      DOC_INDEX_PATH,
      new TextEncoder().encode(JSON.stringify(engine.docIndexCache ?? {})),
    );
  });
  engine.docIndexWriteQueued = next;
  engine.docIndexWriteChain = next.catch(() => undefined);
  return next;
}

export async function seedDocIndexFromTree(engine: VaultEngine): Promise<DocIndex> {
  const index: DocIndex = {};
  for (const node of engine.tree.allNodes()) {
    if (node.kind !== "markdown" || !node.documentId) continue;
    const path = buildPathFromNode(engine.tree, node);
    if (!path) continue;
    const bytes = await engine.docStore.readMaterialized(path);
    if (!bytes) continue;
    const raw = new TextDecoder().decode(bytes);
    const legacyId = extractIdFromMarkdown(raw);
    const content = legacyId ? stripIdComment(raw): raw;
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
export async function touchIndexEntry(
  engine: VaultEngine,
  path: string,
  documentId: string,
  content: string,
  frontiers?: OpId[],
): Promise<void> {
  const index = await engine.loadDocIndex();
  index[path] = {
    id: documentId,
    contentHash: await sha256Text(content),
    size: content.length,
    mtime: Date.now(),
    ...(frontiers ? { frontiers } : {}),
  };
  engine.indexTouchesThisPass?.add(path);
  await engine.saveDocIndex(index);
}

/**
 * True when a document's file on disk no longer matches what this engine
 * last wrote or ingested there — an external edit that hasn't been
 * ingested yet. Anything about to rewrite that file (a client's save on
 * the server) must ingest first, or the external edit is overwritten.
 */
export async function hasPendingExternalEdit(engine: VaultEngine, documentId: string): Promise<boolean> {
  const node = engine.tree.findByDocumentId(documentId);
  const path = engine.materializedPaths.get(documentId) ?? (node ? buildPathFromNode(engine.tree, node): null);
  return path ? engine.externalEditPendingAt(path): false;
}

/**
 * True when the file at `path` differs from what the index says this
 * engine last wrote there (and, if given, from `aboutToWrite`). Writing
 * over it would destroy an external edit the watcher hasn't ingested yet.
 * No index entry means the engine never wrote the path: nothing to
 * protect.
 */
export async function externalEditPendingAt(
  engine: VaultEngine,
  path: string,
  aboutToWrite?: string,
): Promise<boolean> {
  const entry = (await engine.loadDocIndex())[path];
  if (!entry) return false;
  const bytes = await engine.docStore.readMaterialized(path);
  if (!bytes) return false;
  const raw = new TextDecoder().decode(bytes);
  const content = extractIdFromMarkdown(raw) ? stripIdComment(raw): raw;
  if (aboutToWrite !== undefined && content === aboutToWrite) return false;
  return (await sha256Text(content)) !== entry.contentHash;
}

/**
 * Called instead of a Markdown write whose target holds an un-ingested
 * external edit. The file, checkpoint and index are left alone so the
 * next ingest pass sees the edit and three-way merges it.
 */
export async function deferWriteForExternalEdit(
  engine: VaultEngine,
  documentId: string,
  path: string,
): Promise<void> {
  console.warn(
    `[VaultEngine] not writing "${path}": it was edited outside the app since the last ` +
      `write; leaving it for the external-change ingest to merge.`,
  );
  await engine.diag("defer-write-external-edit", { detail: `${documentId} ${path}` });
}

/**
 * Drop the cached doc index so the next use re-reads the file. For a tab
 * that becomes the writer: another tab may have written the index since
 * this one read it.
 */
export function forgetCachedDocIndex(engine: VaultEngine): void {
  if (!engine.docIndexWriteQueued) engine.docIndexCache = null;
}

/** Mirror of touchIndexEntry for the app's own deletions/moves-away. */
export async function dropIndexEntry(engine: VaultEngine, path: string): Promise<void> {
  const index = await engine.loadDocIndex();
  if (path in index) {
    delete index[path];
    await engine.saveDocIndex(index);
  }
}
