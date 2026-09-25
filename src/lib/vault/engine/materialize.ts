import { CONTENT_KEY } from "@/lib/core/document";
import { sha256Text } from "@/lib/core/hash";
import type { MaterializationCheckpoint, PersistedDocState } from "@/lib/core/types";
import type { VaultEngine } from "@/lib/vault/engine";
import { buildPathFromNode } from "@/lib/vault/engine/helpers";

/** Markdown writes: the `.md` mirror of each document (SPEC §11). */

/**
 * Materialise one document to disk (§11):
 *   - compute hash of the Markdown content
 *   - write .md atomically via tmp → rename
 *   - persist the CRDT snapshot atomically via compact()
 *   - store materialisation checkpoint (sha256 + Loro frontiers)
 */
export async function materializeDocument(
  engine: VaultEngine,
  documentId: string,
  filePath: string,
): Promise<MaterializationCheckpoint | null> {
  await engine.loadStoredDocument(documentId);
  const doc = engine.documents.get(documentId);
  if (!doc) return null;

  doc.doc.commit();
  const markdown = doc.getText(CONTENT_KEY).toString();
  const frontiers = doc.doc.oplogFrontiers();
  const hash = await sha256Text(markdown);

  if (await engine.externalEditPendingAt(filePath, markdown)) {
    await engine.deferWriteForExternalEdit(documentId, filePath);
    return null;
  }

  // 1. Write materialised .md atomically (UTF-8 only here)
  const mdBytes = new TextEncoder().encode(markdown);
  await engine.materializedWrite(filePath, mdBytes);

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
  await engine.docStore.compact(documentId, snapBytes, persistedState);
  engine.materializedPaths.set(documentId, filePath);
  await engine.touchIndexEntry(filePath, documentId, markdown, frontiers);
  await engine.updateIndexesForDocument(documentId);

  return checkpoint;
}

/**
 * Materialise all tree-tracked documents. Used on first boot and repair.
 * Returns a recovery report so callers know what changed.
 */
export async function materializeAll(
  engine: VaultEngine,
  rootPath: string,
): Promise<Map<string, MaterializationCheckpoint>> {
  await engine.allDocumentsLoaded;
  const checkpoints = new Map<string, MaterializationCheckpoint>();
  for (const node of engine.tree.allNodes()) {
    if (node.kind !== "markdown" || !node.documentId) continue;
    const filePath = buildPathFromNode(engine.tree, node);
    if (!filePath) continue;
    const cp = await engine.materializeDocument(
      node.documentId,
      `${rootPath}/${filePath}`,
    );
    if (cp) checkpoints.set(node.documentId, cp);
  }
  return checkpoints;
}

/** Materialise specific documents at their current tree path. */
export async function materializeDocuments(
  engine: VaultEngine,
  documentIds: Iterable<string>,
): Promise<void> {
  for (const id of documentIds) {
    const node = engine.tree.findByDocumentId(id);
    const filePath = node && buildPathFromNode(engine.tree, node);
    if (filePath) await engine.materializeDocument(id, filePath);
  }
}

/**
 * Write a document's current content to its current tree path, and
 * remove the file at its *previous* materialised path (tracked in
 * `materializedPaths`) if that path changed — e.g. after a rename or a
 * move into a different folder. No-op if the doc isn't tree-tracked.
 */
export async function materializeToTreePath(engine: VaultEngine, documentId: string): Promise<boolean> {
  const node = engine.tree.findByDocumentId(documentId);
  const doc = engine.documents.get(documentId);
  if (!node || !doc) return true;
  const newPath = buildPathFromNode(engine.tree, node);
  if (!newPath) return true;
  const oldPath = engine.materializedPaths.get(documentId);
  doc.doc.commit();
  const content = doc.getText(CONTENT_KEY).toString();
  if (await engine.externalEditPendingAt(newPath, content)) {
    await engine.deferWriteForExternalEdit(documentId, newPath);
    return false;
  }
  const bytes = new TextEncoder().encode(content);
  await engine.materializedWrite(newPath, bytes);
  if (oldPath && oldPath !== newPath) {
    await engine.materializedRemove(oldPath);
    await engine.dropIndexEntry(oldPath);
  }
  engine.materializedPaths.set(documentId, newPath);
  await engine.touchIndexEntry(newPath, documentId, content, doc.doc.oplogFrontiers());
  await engine.updateIndexesForDocument(documentId);
  return true;
}

/** Check if a materialised file is stale compared to the CRDT document. */
export async function isStale(engine: VaultEngine, documentId: string, filePath: string): Promise<boolean> {
  const doc = engine.documents.get(documentId);
  if (!doc) return false;
  const mdBytes = await engine.docStore.readMaterialized(filePath);
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
export async function repairDocument(
  engine: VaultEngine,
  documentId: string,
  filePath: string,
): Promise<MaterializationCheckpoint | null> {
  const doc = engine.documents.get(documentId);
  if (!doc) return null;
  const currentContent = doc.getText(CONTENT_KEY).toString();
  const mdBytes = new TextEncoder().encode(currentContent);
  await engine.materializedWrite(filePath, mdBytes);
  engine.materializedPaths.set(documentId, filePath);
  const frontiers = doc.doc.oplogFrontiers();
  await engine.touchIndexEntry(filePath, documentId, currentContent, frontiers);
  const hash = await sha256Text(doc.getText(CONTENT_KEY).toString());
  const now = Date.now();
  const checkpoint: MaterializationCheckpoint = { documentId, frontiers, sha256: hash };
  await engine.docStore.compact(
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
  await engine.updateIndexesForDocument(documentId);
  return checkpoint;
}
