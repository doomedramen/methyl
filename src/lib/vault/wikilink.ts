import type { VaultTree } from "@/lib/vault/tree";
import { buildPathFromNode } from "@/lib/vault/engine";

/**
 * `[[wikilink]]` resolution against the vault tree.
 *
 * A wikilink target is the note's file name without `.md`, matched
 * case-insensitively, optionally qualified with a folder path
 * (`[[Projects/Note]]`). This module is pure — no DOM, no CodeMirror — so
 * the resolution rule can be unit tested directly.
 */

export interface WikilinkCandidate {
  documentId: string;
  /** Full vault path, e.g. "Projects/Note.md". */
  path: string;
  /** File name without extension, e.g. "Note". */
  name: string;
  /** Folder portion of `path`, "" for a root note. */
  folder: string;
}

/** Strip a trailing `.md` (case-insensitive). */
function stripMdExt(name: string): string {
  return name.replace(/\.md$/i, "");
}

function splitFolder(path: string): { folder: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { folder: "", name: stripMdExt(path) };
  return { folder: path.slice(0, idx), name: stripMdExt(path.slice(idx + 1)) };
}

/** Enumerate every markdown note in the tree as a resolvable candidate. */
export function listWikilinkCandidates(tree: VaultTree): WikilinkCandidate[] {
  const out: WikilinkCandidate[] = [];
  for (const id of tree.documentIds()) {
    const node = tree.findByDocumentId(id);
    if (!node) continue;
    const path = buildPathFromNode(tree, node);
    if (!path) continue;
    const { folder, name } = splitFolder(path);
    out.push({ documentId: id, path, name, folder });
  }
  return out;
}

/**
 * Parse a raw `[[target]]` or `[[target|alias]]` body (without the `[[` `]]`
 * delimiters) into the target text and optional alias.
 */
export function parseWikilinkBody(body: string): { target: string; alias?: string } {
  const pipe = body.indexOf("|");
  if (pipe === -1) return { target: body.trim() };
  return { target: body.slice(0, pipe).trim(), alias: body.slice(pipe + 1).trim() };
}

/**
 * Resolve a wikilink target string to a document id.
 *
 * Ambiguity rule (documented, not incidental): when several notes share the
 * same case-insensitive name (and, if the target is folder-qualified, the
 * same folder),
 *   1. an exact case-insensitive full-path match wins outright;
 *   2. otherwise a note in the same folder as `currentDocId` wins;
 *   3. otherwise the first match in tree order (candidate array order,
 *      itself derived from `tree.documentIds()`/tree node order) wins.
 */
export function resolveWikilink(
  tree: VaultTree,
  target: string,
  currentDocId?: string,
): string | undefined {
  const trimmed = stripMdExt(target.trim());
  if (!trimmed) return undefined;

  const qualified = trimmed.includes("/");
  const { folder: wantFolder, name: wantName } = splitFolder(trimmed);
  const wantNameLower = wantName.toLowerCase();
  const wantFolderLower = wantFolder.toLowerCase();

  const candidates = listWikilinkCandidates(tree);
  const matches = candidates.filter((c) => {
    if (c.name.toLowerCase() !== wantNameLower) return false;
    if (qualified && c.folder.toLowerCase() !== wantFolderLower) return false;
    return true;
  });

  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0].documentId;

  if (qualified) {
    const exactPath = matches.find((c) => c.path.toLowerCase() === `${trimmed.toLowerCase()}.md`);
    if (exactPath) return exactPath.documentId;
  }

  if (currentDocId) {
    const currentNode = tree.findByDocumentId(currentDocId);
    const currentPath = currentNode && buildPathFromNode(tree, currentNode);
    const currentFolder = currentPath ? splitFolder(currentPath).folder : "";
    const sameFolder = matches.find((c) => c.folder === currentFolder);
    if (sameFolder) return sameFolder.documentId;
  }

  return matches[0].documentId;
}

/**
 * Build the shortest `[[...]]` target string that resolves back to
 * `documentId` unambiguously: the bare name, or `Folder/Name` when another
 * note shares the same case-insensitive name.
 */
export function buildWikilinkTarget(tree: VaultTree, documentId: string): string | undefined {
  const node = tree.findByDocumentId(documentId);
  if (!node) return undefined;
  const path = buildPathFromNode(tree, node);
  if (!path) return undefined;
  const { folder, name } = splitFolder(path);

  const candidates = listWikilinkCandidates(tree);
  const sameName = candidates.filter(
    (c) => c.documentId !== documentId && c.name.toLowerCase() === name.toLowerCase(),
  );
  if (sameName.length === 0) return name;
  return folder ? `${folder}/${name}` : name;
}
