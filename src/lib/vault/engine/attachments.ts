import type { TreeID } from "loro-crdt";
import { sha256Hex } from "@/lib/core/hash";
import { attachmentMimeType } from "@/lib/vault/attachments";
import type { VaultEngine } from "@/lib/vault/engine";
import {
  ATTACHMENTS_FOLDER_NAME,
  buildPathFromNode,
  IGNORED_EXTERNAL_DIRECTORY_SEGMENTS,
  isIgnoredExternalPath,
  isMarkdownPath,
} from "@/lib/vault/engine/helpers";
import type { AssetIngestReport } from "@/lib/vault/engine/types";
import type { VaultTreeNode } from "@/lib/vault/tree";

/** Binary attachments: tree nodes whose bytes live as ordinary files in the vault (SPEC §28). */

/** Return the user-visible path for a tracked binary asset. */
export function attachmentPath(engine: VaultEngine, treeId: TreeID): string | null {
  const node = engine.tree.getNode(treeId);
  if (!node || node.kind !== "binary") return null;
  return buildPathFromNode(engine.tree, node);
}

/** Read an attachment by stable tree node id. */
export async function readAttachment(engine: VaultEngine, treeId: TreeID): Promise<Uint8Array | null> {
  const path = engine.attachmentPath(treeId);
  return path ? engine.docStore.readMaterialized(path): null;
}

/** Create an attachment under Attachments/ or an explicit folder. */
export async function createAttachment(
  engine: VaultEngine,
  name: string,
  bytes: Uint8Array,
  parentTreeId?: TreeID,
): Promise<VaultTreeNode> {
  const parent = parentTreeId ?? engine.ensureAttachmentsFolder();
  const sha256 = await sha256Hex(bytes);
  const treeId = engine.tree.addBinaryFile(parent, name, {
    sha256,
    size: bytes.byteLength,
    mime: attachmentMimeType(name),
  });
  const node = engine.tree.getNode(treeId);
  if (!node) throw new Error("Attachment tree node was not created");
  const path = buildPathFromNode(engine.tree, node);
  if (!path) throw new Error("Attachment path was not created");
  try {
    await engine.materializedWrite(path, bytes);
    engine.materializedAssetPaths.set(String(treeId), path);
    await engine.persistTreeIncremental();
  } catch (error) {
    // The tree edit has not been durably committed when the byte write or
    // tree append fails. Remove the in-memory node so a caller can retry
    // without leaving a phantom asset in the current session. A successfully
    // written but uncommitted ordinary file remains recoverable as an
    // external file on the next reconciliation pass.
    engine.tree.delete(treeId);
    engine.materializedAssetPaths.delete(String(treeId));
    throw error;
  }
  return node;
}

/** Store downloaded/synced bytes for an existing binary tree node. */
export async function writeAttachment(engine: VaultEngine, treeId: TreeID, bytes: Uint8Array): Promise<void> {
  const node = engine.tree.getNode(treeId);
  if (!node || node.kind !== "binary") throw new Error(`Binary asset not found: ${treeId}`);
  const digest = await sha256Hex(bytes);
  if (node.sha256 && node.sha256 !== digest) {
    throw new Error(`Attachment hash mismatch for ${treeId}`);
  }
  const path = buildPathFromNode(engine.tree, node);
  if (!path) throw new Error(`Attachment path not found: ${treeId}`);
  await engine.materializedWrite(path, bytes);
  engine.materializedAssetPaths.set(String(treeId), path);
}

/** Delete an attachment node and its ordinary on-disk bytes. */
export async function deleteAttachment(engine: VaultEngine, treeId: TreeID): Promise<void> {
  const node = engine.tree.getNode(treeId);
  if (!node || node.kind !== "binary") throw new Error(`Binary asset not found: ${treeId}`);
  const path = engine.materializedAssetPaths.get(String(treeId)) ?? buildPathFromNode(engine.tree, node);
  engine.tree.delete(treeId);
  engine.materializedAssetPaths.delete(String(treeId));
  if (path) await engine.materializedRemove(path);
  await engine.persistTree();
}

/** Rename a binary node and move its ordinary bytes to the new path. */
export async function renameAttachment(engine: VaultEngine, treeId: TreeID, newName: string): Promise<void> {
  const node = engine.tree.getNode(treeId);
  if (!node || node.kind !== "binary") throw new Error(`Binary asset not found: ${treeId}`);
  engine.tree.rename(treeId, newName);
  await engine.rematerializeSubtree(treeId);
  await engine.persistTreeIncremental();
}

/** Adopt ordinary files placed anywhere in the visible vault by an external actor. */
export async function ingestExternalAssets(engine: VaultEngine): Promise<AssetIngestReport> {
  const tracked = new Set(
    engine.tree.allNodes()
      .filter((node) => node.kind === "binary")
      .map((node) => buildPathFromNode(engine.tree, node))
      .filter((path): path is string => path !== null),
  );
  const created: string[] = [];
  for (const path of await engine.docStore.listMaterializedPaths()) {
    if (isIgnoredExternalPath(path) || isMarkdownPath(path) || tracked.has(path)) continue;
    const bytes = await engine.docStore.readMaterialized(path);
    if (!bytes) continue;
    const parts = path.split("/");
    const name = parts.pop();
    if (!name) continue;
    const parent = engine.ensureFolderPath(parts);
    const treeId = engine.tree.addBinaryFile(parent, name, {
      sha256: await sha256Hex(bytes),
      size: bytes.byteLength,
      mime: attachmentMimeType(name),
    });
    engine.materializedAssetPaths.set(String(treeId), path);
    created.push(String(treeId));
  }
  const updated: string[] = [];
  for (const node of engine.tree.allNodes()) {
    if (node.kind !== "binary") continue;
    const path = buildPathFromNode(engine.tree, node);
    if (!path || isIgnoredExternalPath(path) || !tracked.has(path)) continue;
    const bytes = await engine.docStore.readMaterialized(path);
    if (!bytes) continue;
    const sha256 = await sha256Hex(bytes);
    const mime = attachmentMimeType(node.name);
    if (node.sha256 === sha256 && node.size === bytes.byteLength && node.mime === mime) continue;
    engine.tree.updateBinaryMetadata(node.treeId, {
      sha256,
      size: bytes.byteLength,
      mime,
    });
    updated.push(String(node.treeId));
  }
  if (created.length > 0 || updated.length > 0) await engine.persistTree();
  return { created, updated };
}

/**
 * Adopt ordinary directories created outside the app. Files are still the
 * portable source of truth for notes, but a filesystem can also contain an
 * intentionally empty folder, so directory events need their own pass.
 * Metadata/dependency directories remain invisible just like an Obsidian
 * import's skipped folders.
 */
export async function ingestExternalFolders(engine: VaultEngine): Promise<{ created: string[] }> {
  const listDirectories = engine.docStore.listMaterializedDirectories;
  if (!listDirectories) return { created: [] };

  const created: string[] = [];
  const paths = (await listDirectories.call(engine.docStore))
    .map((path) => path.replaceAll("\\", "/").split("/").filter(Boolean))
    .filter((segments) =>
      segments.length > 0 &&
      !segments.some((segment) => IGNORED_EXTERNAL_DIRECTORY_SEGMENTS.has(segment.toLowerCase())),
    )
    .sort((a, b) => a.length - b.length);

  for (const segments of paths) {
    engine.ensureFolderPath(segments, created);
  }

  if (created.length > 0) await engine.persistTree();
  return { created };
}

export function ensureAttachmentsFolder(engine: VaultEngine): TreeID {
  const existing = engine.tree.roots().find(
    (node) => node.kind === "directory" && node.name === ATTACHMENTS_FOLDER_NAME,
  );
  return existing?.treeId ?? engine.tree.addDirectory(undefined, ATTACHMENTS_FOLDER_NAME);
}

export async function rematerializeAsset(
  engine: VaultEngine,
  treeId: TreeID,
  node: VaultTreeNode,
): Promise<void> {
  const newPath = buildPathFromNode(engine.tree, node);
  if (!newPath) return;
  const key = String(treeId);
  const oldPath = engine.materializedAssetPaths.get(key);
  const bytes = await engine.docStore.readMaterialized(oldPath ?? newPath);
  if (bytes) await engine.materializedWrite(newPath, bytes);
  if (oldPath && oldPath !== newPath) await engine.materializedRemove(oldPath);
  engine.materializedAssetPaths.set(key, newPath);
}
