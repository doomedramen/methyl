import type { VaultTree } from "@/lib/vault/tree";
import { buildPathFromNode } from "@/lib/vault/engine";

/**
 * Vault path <-> document id, for the `?note=` URL parameter.
 *
 * The URL carries the path (`Projects/welcome.md`) rather than the document
 * id: it stays meaningful to a human, survives a vault that was re-created
 * from the same files, and can be pasted between devices syncing the same
 * vault. The tradeoff is that a note renamed in another tab while this URL
 * is open no longer resolves — `docIdForPath` simply returns undefined and
 * the caller falls back to "nothing open".
 */
export function pathForDocId(tree: VaultTree, documentId: string): string | null {
  const node = tree.findByDocumentId(documentId);
  if (!node) return null;
  return buildPathFromNode(tree, node);
}

export function docIdForPath(tree: VaultTree, path: string): string | undefined {
  const wanted = normalizeNotePath(path);
  if (!wanted) return undefined;
  for (const id of tree.documentIds()) {
    const node = tree.findByDocumentId(id);
    if (!node) continue;
    const candidate = buildPathFromNode(tree, node);
    if (candidate && normalizeNotePath(candidate) === wanted) return id;
  }
  return undefined;
}

/** Trim slashes and collapse empties so "/a//b.md" and "a/b.md" match. */
export function normalizeNotePath(path: string): string {
  return path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

/**
 * Extract the vault path from a location pathname like
 * `/local/Projects/note.md`. Returns null when the path doesn't belong to
 * this vault (wrong vault segment, or the bare app root).
 */
export function notePathFromLocation(pathname: string, vaultId: string): string | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeSafe);
  if (parts.length < 2) return null;
  if (parts[0] !== vaultId) return null;
  return normalizeNotePath(parts.slice(1).join("/")) || null;
}

function decodeSafe(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
