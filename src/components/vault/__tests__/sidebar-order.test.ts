import { describe, expect, it } from "vitest";
import type { TreeID } from "loro-crdt";
import type { BinaryRow, FolderRow, NoteRow, SidebarRow } from "../AppSidebar";
import { sortSidebarRows } from "../sidebar-order";

function folder(treeId: string, name: string, children: SidebarRow[] = []): FolderRow {
  return { treeId: treeId as TreeID, kind: "directory", name, children };
}

function note(treeId: string, title: string): NoteRow {
  return {
    treeId: treeId as TreeID,
    kind: "markdown",
    id: treeId,
    title,
    isGraph: false,
  };
}

function binary(treeId: string, title: string): BinaryRow {
  return { treeId: treeId as TreeID, kind: "binary", id: treeId, title };
}

function label(row: SidebarRow): string {
  return row.kind === "directory" ? `folder:${row.name}` : `file:${row.title}`;
}

describe("sortSidebarRows", () => {
  it("puts folders first and sorts each group by visible name", () => {
    const rows = [
      note("note-z", "Zebra"),
      folder("folder-z", "Zebra folder"),
      binary("asset-a", "Alpha.png"),
      folder("folder-a", "alpha folder"),
      note("note-a", "alpha"),
    ];

    expect(sortSidebarRows(rows).map(label)).toEqual([
      "folder:alpha folder",
      "folder:Zebra folder",
      "file:alpha",
      "file:Alpha.png",
      "file:Zebra",
    ]);
  });

  it("sorts nested children without mutating the input rows", () => {
    const rows = [folder("folder", "Projects", [note("z", "Zeta"), note("a", "Alpha")])];

    const sorted = sortSidebarRows(rows);

    expect(sorted[0]?.kind === "directory" ? sorted[0].children.map(label) : []).toEqual([
      "file:Alpha",
      "file:Zeta",
    ]);
    expect(rows[0]?.kind === "directory" ? rows[0].children.map(label) : []).toEqual([
      "file:Zeta",
      "file:Alpha",
    ]);
  });
});
