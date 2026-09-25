import type { TreeID } from "loro-crdt";
import { readRenamedKey } from "@/lib/browser/storage-keys";

/** The sidebar tree's rows, their flattened (visible) form, and per-vault collapsed folders. */

export interface FolderRow {
  treeId: TreeID;
  kind: "directory";
  name: string;
  children: SidebarRow[];
}

export interface NoteRow {
  treeId: TreeID;
  kind: "markdown";
  id: string;
  title: string;
  path?: string;
  /** Body is a single mermaid flowchart block (SPEC §37) — shown with a
   *  distinct icon and opened in the graph editor rather than as text. */
  isGraph: boolean;
}

export interface BinaryRow {
  treeId: TreeID;
  kind: "binary";
  id: string;
  title: string;
  path?: string;
  sha256?: string;
}

export type SidebarRow = FolderRow | NoteRow | BinaryRow;

export interface MoveTarget {
  treeId: TreeID;
  newParent: TreeID | undefined;
  index: number;
}

/** Folder tree ids are per vault, so is the collapsed state. */
const collapsedKey = (vaultId: string) => `methyl.sidebar.collapsedFolders:${vaultId}`;

export function collectFolderIds(rows: SidebarRow[], folderIds = new Set<string>()): Set<string> {
  for (const row of rows) {
    if (row.kind !== "directory") continue;
    folderIds.add(row.treeId);
    collectFolderIds(row.children, folderIds);
  }
  return folderIds;
}

export function loadCollapsed(vaultId: string): Set<string> | null {
  try {
    // The default vault inherits what was saved before vaults existed.
    const raw =
      vaultId === "local"
        ? (localStorage.getItem(collapsedKey(vaultId)) ??
          readRenamedKey("methyl.sidebar.collapsedFolders", "adhd.sidebar.collapsedFolders"))
        : localStorage.getItem(collapsedKey(vaultId));
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {
    // Ignore — falls back to the default collapsed state.
  }
  return null;
}

export function saveCollapsed(vaultId: string | null, set: Set<string>) {
  if (!vaultId) return;
  try {
    window.localStorage.setItem(collapsedKey(vaultId), JSON.stringify(Array.from(set)));
  } catch {
    // best-effort only; state still lives in memory for this session
  }
}

export interface FlatRow {
  type: "row";
  row: SidebarRow;
  depth: number;
  parentTreeId: TreeID | undefined;
  siblingIndex: number;
  siblingsLength: number;
}

/** Placeholder shown under an expanded folder that has no children, so the
 *  next top-level rows don't visually read as its children. */
export interface EmptyFlatRow {
  type: "empty";
  key: string;
  depth: number;
}

export interface FolderAfterFlatRow {
  type: "after";
  folderTreeId: TreeID;
  folderName: string;
  depth: number;
}

export type FlatEntry = FlatRow | EmptyFlatRow | FolderAfterFlatRow;

export const AFTER_DROP_PREFIX = "after-folder:";

export function afterDropId(treeId: TreeID): string {
  return `${AFTER_DROP_PREFIX}${treeId}`;
}

export function folderIdFromAfterDropId(id: unknown): TreeID | undefined {
  return typeof id === "string" && id.startsWith(AFTER_DROP_PREFIX)
    ? (id.slice(AFTER_DROP_PREFIX.length) as TreeID)
    : undefined;
}

export function flatten(
  rows: SidebarRow[],
  depth: number,
  parentTreeId: TreeID | undefined,
  collapsed: Set<string>,
  out: FlatEntry[],
) {
  rows.forEach((row, i) => {
    out.push({ type: "row", row, depth, parentTreeId, siblingIndex: i, siblingsLength: rows.length });
    if (row.kind === "directory" && !collapsed.has(row.treeId)) {
      if (row.children.length === 0) {
        out.push({ type: "empty", key: `${row.treeId}-empty`, depth: depth + 1 });
      } else {
        flatten(row.children, depth + 1, row.treeId, collapsed, out);
      }
    }
    if (row.kind === "directory") {
      // Keep a drop target after the entire visible subtree. This gives a
      // dragged child a reliable way to leave its folder, even when the
      // folder's first child wins row collision detection near its header.
      out.push({
        type: "after",
        folderTreeId: row.treeId,
        folderName: row.name,
        depth,
      });
    }
  });
}

export function findRow(rows: SidebarRow[], treeId: TreeID): SidebarRow | undefined {
  for (const row of rows) {
    if (row.treeId === treeId) return row;
    if (row.kind === "directory") {
      const found = findRow(row.children, treeId);
      if (found) return found;
    }
  }
  return undefined;
}

export function countNotes(row: FolderRow): number {
  let n = 0;
  for (const child of row.children) {
    if (child.kind === "markdown") n += 1;
    else if (child.kind === "directory") n += countNotes(child);
  }
  return n;
}
