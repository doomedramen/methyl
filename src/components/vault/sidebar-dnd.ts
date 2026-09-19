import type { TreeID } from "loro-crdt";

export type DropMode = "before" | "after" | "inside";

/**
 * The small structural view used by the drag resolver. Keeping this shape
 * independent from the sidebar components makes the placement rules easy to
 * exercise without a browser or a DndContext.
 */
export interface SidebarDndRow {
  treeId: TreeID;
  kind: "directory" | "markdown";
  name?: string;
  title?: string;
  children?: readonly SidebarDndRow[];
}

export interface VisibleDndRow {
  treeId: TreeID;
  depth: number;
  parentTreeId: TreeID | undefined;
  siblingIndex: number;
  kind: SidebarDndRow["kind"];
}

export type PlacementReason = "self" | "descendant" | "no-target" | "no-destination";

export interface SidebarPlacement {
  mode: DropMode;
  targetTreeId: TreeID | undefined;
  parentTreeId: TreeID | undefined;
  index: number;
  depth: number;
  valid: boolean;
  noOp: boolean;
  reason?: PlacementReason;
  visualBoundary: {
    kind: DropMode;
    anchorTreeId: TreeID | undefined;
  };
}

export interface ResolvePlacementInput {
  rows: readonly SidebarDndRow[];
  visibleRows: readonly VisibleDndRow[];
  activeId: TreeID;
  targetTreeId?: TreeID;
  relativeY?: number;
  targetIsAfterBoundary?: boolean;
  pointerX?: number;
  baseX?: number;
  grabOffsetX?: number;
  indentPx?: number;
}

const DEFAULT_INDENT_PX = 17.6;

/** Pure hit-testing for the vertical part of a drop. */
export function computeDropMode(relative: number, isDirectory: boolean): DropMode {
  if (isDirectory) {
    if (relative < 0.25) return "before";
    if (relative > 0.75) return "after";
    return "inside";
  }
  return relative < 0.5 ? "before" : "after";
}

function childrenOf(row: SidebarDndRow | undefined): readonly SidebarDndRow[] {
  return row?.kind === "directory" ? row.children ?? [] : [];
}

function rowName(row: SidebarDndRow | undefined): string {
  if (!row) return "item";
  return row.kind === "directory" ? row.name ?? "folder" : row.title ?? "note";
}

function findRow(rows: readonly SidebarDndRow[], treeId: TreeID): SidebarDndRow | undefined {
  for (const row of rows) {
    if (row.treeId === treeId) return row;
    const found = findRow(childrenOf(row), treeId);
    if (found) return found;
  }
  return undefined;
}

function findPath(
  rows: readonly SidebarDndRow[],
  treeId: TreeID,
  path: SidebarDndRow[] = [],
): SidebarDndRow[] | undefined {
  for (const row of rows) {
    const nextPath = [...path, row];
    if (row.treeId === treeId) return nextPath;
    const found = findPath(childrenOf(row), treeId, nextPath);
    if (found) return found;
  }
  return undefined;
}

function findLocation(
  rows: readonly SidebarDndRow[],
  treeId: TreeID,
): { parentTreeId: TreeID | undefined; index: number; depth: number } | undefined {
  const visit = (
    siblings: readonly SidebarDndRow[],
    parentTreeId: TreeID | undefined,
    depth: number,
  ): { parentTreeId: TreeID | undefined; index: number; depth: number } | undefined => {
    for (let index = 0; index < siblings.length; index += 1) {
      const row = siblings[index];
      if (row.treeId === treeId) return { parentTreeId, index, depth };
      const found = visit(childrenOf(row), row.treeId, depth + 1);
      if (found) return found;
    }
    return undefined;
  };

  return visit(rows, undefined, 0);
}

function isDescendant(
  rows: readonly SidebarDndRow[],
  ancestorId: TreeID,
  candidateId: TreeID,
): boolean {
  const ancestor = findRow(rows, ancestorId);
  return ancestor ? Boolean(findRow(childrenOf(ancestor), candidateId)) : false;
}

function isOnPath(
  rows: readonly SidebarDndRow[],
  ancestorId: TreeID | undefined,
  candidateId: TreeID | undefined,
): boolean {
  if (ancestorId === undefined || candidateId === undefined) return false;
  return Boolean(findPath(rows, candidateId)?.some((row) => row.treeId === ancestorId));
}

function directChildOnPath(
  rows: readonly SidebarDndRow[],
  parentTreeId: TreeID | undefined,
  targetTreeId: TreeID,
): TreeID | undefined {
  const path = findPath(rows, targetTreeId);
  if (!path) return undefined;
  if (parentTreeId === undefined) return path[0]?.treeId;
  const parentIndex = path.findIndex((row) => row.treeId === parentTreeId);
  return parentIndex >= 0 ? path[parentIndex + 1]?.treeId : undefined;
}

function ancestorParents(
  rows: readonly SidebarDndRow[],
  parentTreeId: TreeID | undefined,
): (TreeID | undefined)[] {
  if (parentTreeId === undefined) return [undefined];
  const path = findPath(rows, parentTreeId);
  if (!path) return [undefined];
  return [undefined, ...path.filter((row) => row.kind === "directory").map((row) => row.treeId)];
}

function parentDepth(rows: readonly SidebarDndRow[], parentTreeId: TreeID | undefined): number {
  // The depth here is the depth of a new child under the parent. Root items
  // are depth 0; a child of a root folder is depth 1.
  return parentTreeId === undefined ? 0 : (findPath(rows, parentTreeId)?.length ?? 1);
}

function normalizeIndex(
  rows: readonly SidebarDndRow[],
  activeId: TreeID,
  parentTreeId: TreeID | undefined,
  index: number,
): number {
  const source = findLocation(rows, activeId);
  if (!source || source.parentTreeId !== parentTreeId || source.index >= index) return index;
  return Math.max(0, index - 1);
}

function invalidPlacement(
  mode: DropMode,
  targetTreeId: TreeID | undefined,
  reason: PlacementReason,
): SidebarPlacement {
  return {
    mode,
    targetTreeId,
    parentTreeId: undefined,
    index: -1,
    depth: 0,
    valid: false,
    noOp: false,
    reason,
    visualBoundary: { kind: mode, anchorTreeId: targetTreeId },
  };
}

/**
 * Resolve a pointer target into the same normalized move object used by both
 * the preview and the eventual onMove call.
 *
 * Vertical intent is selected from the hovered row (or its after-subtree
 * boundary); horizontal intent selects the closest valid parent depth at that
 * boundary. A parent candidate is either on the target's ancestor path or a
 * folder whose visible subtree ends immediately before the boundary.
 */
export function resolveSidebarPlacement(input: ResolvePlacementInput): SidebarPlacement {
  const {
    rows,
    visibleRows,
    activeId,
    targetTreeId,
    targetIsAfterBoundary = false,
    pointerX,
    baseX,
    grabOffsetX = 0,
    indentPx = DEFAULT_INDENT_PX,
  } = input;

  const activeRow = findRow(rows, activeId);
  const target = targetTreeId ? findRow(rows, targetTreeId) : undefined;
  const targetFlat = targetTreeId
    ? visibleRows.find((entry) => entry.treeId === targetTreeId)
    : undefined;
  let mode: DropMode = targetIsAfterBoundary
    ? "after"
    : targetFlat && target
      ? computeDropMode(input.relativeY ?? 0.5, target.kind === "directory")
      : "after";

  if (!targetTreeId || !target || !targetFlat) return invalidPlacement(mode, targetTreeId, "no-target");
  if (targetTreeId === activeId) return invalidPlacement(mode, targetTreeId, "self");
  if (activeRow?.kind === "directory" && isDescendant(rows, activeId, targetTreeId)) {
    return invalidPlacement(mode, targetTreeId, "descendant");
  }

  // The space between two sibling rows is one physical insertion boundary.
  // Canonicalize "before the lower row" to "after the upper row" so the
  // preview, announcement, and committed move cannot expose two slots for
  // the same location. Keep an active source row as-is so a self-adjacent
  // no-op still resolves through the normal normalization path.
  let resolvedTargetTreeId = targetTreeId;
  let resolvedTarget = target;
  let resolvedTargetFlat = targetFlat;
  if (!targetIsAfterBoundary && mode === "before") {
    const targetIndex = visibleRows.findIndex((entry) => entry.treeId === resolvedTargetTreeId);
    const previous = visibleRows
      .slice(0, targetIndex)
      .reverse()
      .find((entry) => entry.parentTreeId === targetFlat.parentTreeId);
    if (
      previous &&
      previous.parentTreeId === targetFlat.parentTreeId &&
      previous.treeId !== activeId
    ) {
      const previousRow = findRow(rows, previous.treeId);
      if (previousRow) {
        resolvedTargetTreeId = previous.treeId;
        resolvedTarget = previousRow;
        resolvedTargetFlat = previous;
        mode = "after";
      }
    }
  }

  const naturalParent = mode === "inside" ? resolvedTargetTreeId : resolvedTargetFlat.parentTreeId;
  const naturalIndex =
    mode === "inside"
      ? childrenOf(resolvedTarget).length
      : resolvedTargetFlat.siblingIndex + (mode === "after" ? 1 : 0);
  const visibleSiblings = visibleRows.filter(
    (entry) => entry.parentTreeId === naturalParent,
  );
  const isLastVisibleSibling =
    visibleSiblings[visibleSiblings.length - 1]?.treeId === resolvedTargetTreeId;
  const canMoveOutsideParent =
    targetIsAfterBoundary || (mode === "after" && isLastVisibleSibling);

  // The target's parent path allows outdenting while the visible row before
  // the boundary allows indenting into a preceding folder at the same point.
  const parentCandidates: (TreeID | undefined)[] = [];
  const addCandidate = (candidate: TreeID | undefined) => {
    if (parentCandidates.includes(candidate)) return;
    if (candidate === activeId) return;
    if (candidate && activeRow?.kind === "directory" && isDescendant(rows, activeId, candidate)) return;
    parentCandidates.push(candidate);
  };

  if (mode === "inside") {
    // Folder-centre hovering is an explicit move-inside action. Horizontal
    // depth changes apply to insertion boundaries, not to this affordance.
    addCandidate(naturalParent);
  } else {
    const targetIndex = visibleRows.findIndex((entry) => entry.treeId === resolvedTargetTreeId);
    const boundaryRowIndex = mode === "before" ? targetIndex - 1 : targetIndex;
    const previous = visibleRows[boundaryRowIndex];
    for (const candidate of canMoveOutsideParent
      ? ancestorParents(rows, naturalParent)
      : [naturalParent]) {
      addCandidate(candidate);
    }
    if (previous) {
      if (canMoveOutsideParent) {
        for (const candidate of ancestorParents(rows, previous.parentTreeId)) addCandidate(candidate);
      }
      if (previous.kind === "directory") addCandidate(previous.treeId);
    }
    if (mode === "after" && resolvedTarget.kind === "directory") {
      addCandidate(resolvedTarget.treeId);
    }
  }
  if (parentCandidates.length === 0) {
    return invalidPlacement(mode, resolvedTargetTreeId, "no-destination");
  }

  const source = findLocation(rows, activeId);
  const naturalDepth = parentDepth(rows, naturalParent);
  const initialPointerX =
    baseX === undefined ? undefined : baseX + (source?.depth ?? 0) * indentPx + grabOffsetX;
  const horizontalDelta =
    pointerX === undefined || initialPointerX === undefined ? undefined : pointerX - initialPointerX;
  const desiredDepth =
    mode === "inside"
      ? naturalDepth
      : horizontalDelta === undefined
      ? naturalDepth
      : Math.max(0, naturalDepth + Math.round(horizontalDelta / Math.max(1, indentPx)));

  const orderedCandidates = parentCandidates
    .map((parentTreeId, order) => ({
      parentTreeId,
      depth: parentDepth(rows, parentTreeId),
      order,
    }))
    .sort((a, b) => {
      const distance = Math.abs(a.depth - desiredDepth) - Math.abs(b.depth - desiredDepth);
      return distance || a.order - b.order;
    });
  const selected = orderedCandidates[0];
  if (!selected) return invalidPlacement(mode, resolvedTargetTreeId, "no-destination");

  let rawIndex = naturalIndex;
  if (selected.parentTreeId !== naturalParent) {
    const branchId = directChildOnPath(rows, selected.parentTreeId, resolvedTargetTreeId);
    const selectedParent =
      selected.parentTreeId === undefined ? undefined : findRow(rows, selected.parentTreeId);
    const selectedChildren = selected.parentTreeId === undefined ? rows : childrenOf(selectedParent);
    const branchIndex = branchId
      ? selectedChildren.findIndex((row) => row.treeId === branchId)
      : -1;
    if (branchIndex >= 0 && isOnPath(rows, selected.parentTreeId, naturalParent)) {
      rawIndex = branchIndex + (mode === "after" ? 1 : 0);
    } else {
      rawIndex = selectedChildren.length;
    }
  }

  const index = normalizeIndex(rows, activeId, selected.parentTreeId, rawIndex);
  const noOp = Boolean(
    source && source.parentTreeId === selected.parentTreeId && source.index === index,
  );

  return {
    mode,
    targetTreeId: resolvedTargetTreeId,
    parentTreeId: selected.parentTreeId,
    index,
    depth: selected.depth,
    valid: true,
    noOp,
    visualBoundary: { kind: mode, anchorTreeId: resolvedTargetTreeId },
  };
}

/** Recheck an already displayed placement against the tree at release time. */
export function revalidateSidebarPlacement(
  rows: readonly SidebarDndRow[],
  activeId: TreeID,
  placement: SidebarPlacement,
): SidebarPlacement {
  if (!placement.valid || placement.targetTreeId === undefined) return placement;
  const target = findRow(rows, placement.targetTreeId);
  const active = findRow(rows, activeId);
  if (!target || !active) return invalidPlacement(placement.mode, placement.targetTreeId, "no-target");
  if (placement.targetTreeId === activeId) {
    return invalidPlacement(placement.mode, placement.targetTreeId, "self");
  }
  if (active.kind === "directory" && isDescendant(rows, activeId, placement.targetTreeId)) {
    return invalidPlacement(placement.mode, placement.targetTreeId, "descendant");
  }
  if (placement.parentTreeId === activeId) return invalidPlacement(placement.mode, placement.targetTreeId, "self");
  if (
    placement.parentTreeId &&
    active.kind === "directory" &&
    isDescendant(rows, activeId, placement.parentTreeId)
  ) {
    return invalidPlacement(placement.mode, placement.targetTreeId, "descendant");
  }

  const parent =
    placement.parentTreeId === undefined ? undefined : findRow(rows, placement.parentTreeId);
  if (placement.parentTreeId !== undefined && parent?.kind !== "directory") {
    return invalidPlacement(placement.mode, placement.targetTreeId, "no-destination");
  }

  const targetLocation = findLocation(rows, placement.targetTreeId);
  const naturalParent = placement.mode === "inside" ? placement.targetTreeId : targetLocation?.parentTreeId;
  const siblings = placement.parentTreeId === undefined ? rows : childrenOf(parent);
  let index = placement.index;
  if (placement.mode === "inside" && placement.parentTreeId === placement.targetTreeId) {
    index = childrenOf(target).length;
  } else if (targetLocation && placement.parentTreeId === naturalParent) {
    index = targetLocation.index + (placement.mode === "after" ? 1 : 0);
  } else if (placement.parentTreeId === placement.targetTreeId && placement.mode === "after") {
    index = siblings.length;
  } else if (targetLocation && isOnPath(rows, placement.parentTreeId, targetLocation.parentTreeId)) {
    const branchId = directChildOnPath(rows, placement.parentTreeId, placement.targetTreeId);
    const branchIndex = branchId ? siblings.findIndex((row) => row.treeId === branchId) : -1;
    if (branchIndex >= 0) index = branchIndex + (placement.mode === "after" ? 1 : 0);
  }
  index = Math.max(0, Math.min(index, siblings.length));
  index = normalizeIndex(rows, activeId, placement.parentTreeId, index);
  const source = findLocation(rows, activeId);
  const noOp = Boolean(
    source && source.parentTreeId === placement.parentTreeId && source.index === index,
  );

  return {
    ...placement,
    index,
    depth: parentDepth(rows, placement.parentTreeId),
    noOp,
  };
}

export function formatPlacementLabel(
  rows: readonly SidebarDndRow[],
  placement: SidebarPlacement,
  activeId?: TreeID,
): string {
  if (!placement.valid) {
    if (placement.reason === "descendant") return "Cannot move into own folder";
    if (placement.reason === "self") return "No change";
    return "No valid destination";
  }

  const parentPath = placement.parentTreeId
    ? findPath(rows, placement.parentTreeId)?.map(rowName).join(" / ") ?? "folder"
    : "vault root";
  const targetName = rowName(findRow(rows, placement.targetTreeId as TreeID));
  if (placement.mode === "after" && placement.parentTreeId === placement.targetTreeId) {
    const target = findRow(rows, placement.targetTreeId as TreeID);
    const remainingChildren = childrenOf(target).filter((child) => child.treeId !== activeId);
    const previous = remainingChildren[placement.index - 1];
    return previous
      ? `In ${parentPath} · after ${rowName(previous)}`
      : `In ${parentPath} · at end`;
  }
  if (placement.mode === "inside") {
    const target = findRow(rows, placement.targetTreeId as TreeID);
    const remainingChildren = childrenOf(target).filter((child) => child.treeId !== activeId);
    const previous = remainingChildren[placement.index - 1];
    return previous
      ? `In ${parentPath} · after ${rowName(previous)}`
      : `In ${parentPath} · at end`;
  }
  return `${parentPath === "vault root" ? "At" : "In"} ${parentPath} · ${placement.mode} ${targetName}`;
}

export function countDescendants(row: SidebarDndRow): number {
  return childrenOf(row).reduce((count, child) => count + 1 + countDescendants(child), 0);
}

export function getRowName(row: SidebarDndRow | undefined): string {
  return rowName(row);
}
