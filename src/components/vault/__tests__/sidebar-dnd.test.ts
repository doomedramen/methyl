import { describe, expect, it } from "vitest";
import type { TreeID } from "loro-crdt";
import {
  computeDropMode,
  formatPlacementLabel,
  revalidateSidebarPlacement,
  resolveSidebarPlacement,
  type SidebarDndRow,
  type VisibleDndRow,
} from "../sidebar-dnd";

const id = (value: string) => value as TreeID;

function visible(rows: SidebarDndRow[]): VisibleDndRow[] {
  const result: VisibleDndRow[] = [];
  const visit = (
    siblings: readonly SidebarDndRow[],
    depth: number,
    parentTreeId: TreeID | undefined,
  ) => {
    siblings.forEach((row, siblingIndex) => {
      result.push({
        treeId: row.treeId,
        depth,
        parentTreeId,
        siblingIndex,
        kind: row.kind,
      });
      if (row.kind === "directory") visit(row.children ?? [], depth + 1, row.treeId);
    });
  };
  visit(rows, 0, undefined);
  return result;
}

function note(treeId: string, title = treeId): SidebarDndRow {
  return { treeId: id(treeId), kind: "markdown", title };
}

function folder(treeId: string, children: SidebarDndRow[] = []): SidebarDndRow {
  return { treeId: id(treeId), kind: "directory", name: treeId, children };
}

describe("sidebar placement resolver", () => {
  it("normalizes a same-parent move after a later sibling", () => {
    const rows = [note("A"), note("B"), note("C")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("A"),
      targetTreeId: id("C"),
      relativeY: 0.9,
    });

    expect(placement).toMatchObject({
      valid: true,
      parentTreeId: undefined,
      index: 2,
      mode: "after",
      noOp: false,
    });
  });

  it("uses a folder centre as an append-inside placement", () => {
    const rows = [folder("People", [note("Hana")]), note("Garage")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("Garage"),
      targetTreeId: id("People"),
      relativeY: 0.5,
    });

    expect(placement).toMatchObject({
      mode: "inside",
      parentTreeId: id("People"),
      index: 1,
      depth: 1,
    });
  });

  it("uses the last visible child as the append target for an expanded folder", () => {
    const rows = [folder("People", [note("Hana"), note("Work")]), note("Garage")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("Garage"),
      targetTreeId: id("Work"),
      relativeY: 0.9,
    });

    expect(placement).toMatchObject({
      mode: "after",
      parentTreeId: id("People"),
      index: 2,
      depth: 1,
    });
    expect(formatPlacementLabel(rows, placement, id("Garage"))).toBe("In People · after Work");
  });

  it("keeps a middle child insertion inside its current folder", () => {
    const rows = [folder("People", [note("Hana"), note("Work"), note("Later")]), note("Garage")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("Garage"),
      targetTreeId: id("Work"),
      relativeY: 0.9,
      pointerX: -17.6,
      baseX: 0,
      grabOffsetX: 0,
      indentPx: 17.6,
    });

    expect(placement).toMatchObject({
      mode: "after",
      parentTreeId: id("People"),
      index: 2,
      depth: 1,
    });
  });

  it("moves a child out at the folder subtree boundary", () => {
    const rows = [folder("People", [note("Hana"), note("Garage")]), note("Work")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("Garage"),
      targetTreeId: id("People"),
      targetIsAfterBoundary: true,
      pointerX: 0,
      baseX: 0,
      grabOffsetX: 0,
      indentPx: 17.6,
    });

    expect(placement).toMatchObject({
      mode: "after",
      parentTreeId: undefined,
      index: 1,
      depth: 0,
    });
    expect(formatPlacementLabel(rows, placement)).toBe("At vault root · after People");
  });

  it("supports the same subtree boundary when the folder is collapsed", () => {
    const rows = [folder("People", [note("Hana")]), note("Work")];
    const collapsedVisible = visible(rows).filter((entry) => entry.treeId !== id("Hana"));
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: collapsedVisible,
      activeId: id("Work"),
      targetTreeId: id("People"),
      targetIsAfterBoundary: true,
    });

    expect(placement).toMatchObject({ parentTreeId: undefined, index: 1, depth: 0 });
  });

  it("can insert before the first root item", () => {
    const rows = [note("A"), note("B")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("B"),
      targetTreeId: id("A"),
      relativeY: 0.1,
    });

    expect(placement).toMatchObject({ parentTreeId: undefined, index: 0, depth: 0 });
  });

  it("canonicalizes a shared sibling boundary to one after-position", () => {
    const rows = [note("welcome"), note("A"), note("B")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("B"),
      targetTreeId: id("A"),
      relativeY: 0.1,
    });

    expect(placement).toMatchObject({
      mode: "after",
      targetTreeId: id("welcome"),
      parentTreeId: undefined,
      index: 1,
    });
    expect(formatPlacementLabel(rows, placement, id("B"))).toBe(
      "At vault root · after welcome",
    );
  });

  it("canonicalizes the boundary after an expanded folder", () => {
    const rows = [folder("People", [note("Hana"), note("Work")]), note("Garage")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("Work"),
      targetTreeId: id("Garage"),
      relativeY: 0.1,
    });

    expect(placement).toMatchObject({
      mode: "after",
      targetTreeId: id("People"),
      parentTreeId: undefined,
      index: 1,
    });
    expect(formatPlacementLabel(rows, placement, id("Work"))).toBe(
      "At vault root · after People",
    );
  });

  it("uses horizontal movement to indent at a shared boundary", () => {
    const rows = [folder("People", [note("Hana")]), note("Garage")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("Garage"),
      targetTreeId: id("People"),
      relativeY: 0.9,
      pointerX: 18,
      baseX: 0,
      grabOffsetX: 0,
      indentPx: 17.6,
    });

    expect(placement).toMatchObject({
      mode: "after",
      parentTreeId: id("People"),
      index: 1,
      depth: 1,
    });
  });

  it("defaults to outside at a folder subtree boundary", () => {
    const rows = [folder("Folder One", [note("B"), note("A")])];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("B"),
      targetTreeId: id("Folder One"),
      targetIsAfterBoundary: true,
      pointerX: 17.6,
      baseX: 0,
      grabOffsetX: 0,
      indentPx: 17.6,
    });

    expect(placement).toMatchObject({
      mode: "after",
      parentTreeId: undefined,
      index: 1,
      depth: 0,
    });
  });

  it("rejects a folder destination inside its own descendant", () => {
    const rows = [folder("People", [folder("Projects", [note("Hana")])])];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("People"),
      targetTreeId: id("Hana"),
      relativeY: 0.5,
    });

    expect(placement).toMatchObject({ valid: false, reason: "descendant" });
    expect(formatPlacementLabel(rows, placement)).toBe("Cannot move into own folder");
  });

  it("reports a no-op after the current item", () => {
    const rows = [note("A"), note("B")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("B"),
      targetTreeId: id("A"),
      relativeY: 0.9,
    });

    expect(placement).toMatchObject({ valid: true, noOp: true, parentTreeId: undefined, index: 1 });
  });

  it("revalidates a root move after a folder without turning it into a no-op", () => {
    const rows = [note("welcome"), note("Note A"), folder("Folder One"), note("Note B")];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("Note A"),
      targetTreeId: id("Folder One"),
      relativeY: 0.9,
    });

    expect(placement).toMatchObject({ parentTreeId: undefined, index: 2, noOp: false });
    expect(revalidateSidebarPlacement(rows, id("Note A"), placement)).toMatchObject({
      parentTreeId: undefined,
      index: 2,
      noOp: false,
    });
  });

  it("includes the full folder path in a nested destination label", () => {
    const rows = [folder("People", [folder("Projects", [note("Hana")]), note("Garage")])];
    const placement = resolveSidebarPlacement({
      rows,
      visibleRows: visible(rows),
      activeId: id("Garage"),
      targetTreeId: id("Hana"),
      relativeY: 0.1,
    });

    expect(formatPlacementLabel(rows, placement)).toBe("In People / Projects · before Hana");
  });

  it("keeps the existing vertical mode thresholds", () => {
    expect(computeDropMode(0.24, true)).toBe("before");
    expect(computeDropMode(0.5, true)).toBe("inside");
    expect(computeDropMode(0.76, true)).toBe("after");
  });
});
