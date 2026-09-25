import type { TreeID } from "loro-crdt";
import type { VaultTree, VaultTreeNode } from "@/lib/vault/tree";
import { detectGraphDocument } from "@/lib/graph/detect";
import type { BinaryRow, FolderRow, NoteRow, SidebarRow } from "./AppSidebar";
import { sortSidebarRows } from "./sidebar-order";
import type { VaultEngine } from "@/lib/vault/engine";
/**
 * Build the nested folder/note tree for the sidebar, with folders first and
 * files sorted by their visible name at every level.
 * The displayed title is always the tree node's file name (minus `.md`) —
 * never frontmatter `title:` or an `# H1` in the body. Those can be edited
 * or deleted freely without the note vanishing or being relabeled out from
 * under the user; only a rename (which renames the file) changes the title.
 */
export function toRow(node: VaultTreeNode, tree: VaultTree, engine: VaultEngine, parentPath = ""): SidebarRow {
  if (node.kind === "directory") {
    return {
      treeId: node.treeId,
      kind: "directory",
      name: node.name,
      children: tree.children(node.treeId).map((child) => toRow(child, tree, engine, `${parentPath}${node.name}/`)),
    };
  }
  if (node.kind === "binary") {
    const path = `${parentPath}${node.name}`;
    const row: BinaryRow = {
      treeId: node.treeId,
      kind: "binary",
      id: String(node.treeId),
      title: node.name,
      path,
      sha256: node.sha256,
    };
    return row;
  }
  const doc = node.documentId ? engine.getDocument(node.documentId) : undefined;
  const isGraph = doc ? detectGraphDocument(doc.getMarkdown()) !== null : false;
  return {
    treeId: node.treeId,
    kind: "markdown",
    id: node.documentId ?? node.treeId,
    title: node.name.replace(/\.md$/i, ""),
    path: `${parentPath}${node.name}`,
    isGraph,
  };
}

export function buildRootRows(tree: VaultTree, engine: VaultEngine): SidebarRow[] {
  return sortSidebarRows(tree.roots().map((node) => toRow(node, tree, engine)));
}

export function flattenNotes(rows: SidebarRow[]): NoteRow[] {
  const out: NoteRow[] = [];
  for (const row of rows) {
    if (row.kind === "markdown") out.push(row);
    else if (row.kind === "directory") out.push(...flattenNotes(row.children));
  }
  return out;
}

export function findFolder(rows: SidebarRow[], treeId: TreeID): FolderRow | undefined {
  for (const row of rows) {
    if (row.kind === "directory") {
      if (row.treeId === treeId) return row;
      const found = findFolder(row.children, treeId);
      if (found) return found;
    }
  }
  return undefined;
}
