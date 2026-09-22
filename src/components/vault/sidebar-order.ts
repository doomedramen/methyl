import type { SidebarRow } from "./AppSidebar";

const KIND_ORDER: Record<SidebarRow["kind"], number> = {
  directory: 0,
  markdown: 1,
  binary: 1,
};

function visibleName(row: SidebarRow): string {
  return row.kind === "directory" ? row.name : row.title;
}

function compareRows(a: SidebarRow, b: SidebarRow): number {
  const kindOrder = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kindOrder !== 0) return kindOrder;

  const nameOrder = visibleName(a).localeCompare(visibleName(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (nameOrder !== 0) return nameOrder;

  // Same-name siblings are legal after a CRDT merge; keep their display order
  // deterministic without changing the underlying tree.
  return String(a.treeId).localeCompare(String(b.treeId));
}

/** Return a recursively sorted display copy: folders first, then files by name. */
export function sortSidebarRows(rows: readonly SidebarRow[]): SidebarRow[] {
  return [...rows].sort(compareRows).map((row) =>
    row.kind === "directory"
      ? { ...row, children: sortSidebarRows(row.children) }
      : row,
  );
}
