"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeID } from "loro-crdt";
import type { VaultEngine } from "@/lib/vault/engine";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  FolderPlus,
  Inbox,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  defaultKeyboardCoordinateGetter,
  type KeyboardCoordinateGetter,
  type CollisionDetection,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { PwaStatus } from "@/components/pwa/PwaStatus";
import { CreateMenu } from "./CreateMenu";
import {
  RenameNoteDialog,
  DeleteNoteAlert,
  RenameFolderDialog,
  DeleteFolderAlert,
  NewFolderDialog,
} from "./NoteActions";
import {
  countDescendants,
  formatPlacementLabel,
  getRowName,
  revalidateSidebarPlacement,
  resolveSidebarPlacement,
  type SidebarPlacement,
  type VisibleDndRow,
} from "./sidebar-dnd";

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
  /** Body is a single mermaid flowchart block (SPEC §37) — shown with a
   *  distinct icon and opened in the graph editor rather than as text. */
  isGraph: boolean;
}

export type SidebarRow = FolderRow | NoteRow;

export interface MoveTarget {
  treeId: TreeID;
  newParent: TreeID | undefined;
  index: number;
}

interface AppSidebarProps {
  rows: SidebarRow[];
  activeId: string | null;
  /** Passed through to the footer status popover for the diagnostics copy action. */
  engine: VaultEngine | null;
  onCreate: (parentTreeId?: TreeID) => void;
  onCreateGraph: (parentTreeId?: TreeID) => void;
  onCreateFolder: (parentTreeId: TreeID | undefined, name: string) => void;
  onSelect: (id: string) => void;
  onRenameNote: (id: string, title: string) => void;
  onDeleteNote: (id: string) => void;
  onRenameFolder: (treeId: TreeID, name: string) => void;
  onDeleteFolder: (treeId: TreeID) => void;
  onMove: (target: MoveTarget) => void;
  onOpenCommandMenu: () => void;
  newFolderOpen: boolean;
  onNewFolderOpenChange: (open: boolean) => void;
}

const COLLAPSED_KEY = "adhd.sidebar.collapsedFolders";

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch {
    // ignore — falls back to all-expanded
  }
  return new Set();
}

function saveCollapsed(set: Set<string>) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // best-effort only; state still lives in memory for this session
  }
}

interface FlatRow {
  type: "row";
  row: SidebarRow;
  depth: number;
  parentTreeId: TreeID | undefined;
  siblingIndex: number;
  siblingsLength: number;
}

/** Placeholder shown under an expanded folder that has no children, so the
 *  next top-level rows don't visually read as its children. */
interface EmptyFlatRow {
  type: "empty";
  key: string;
  depth: number;
}

interface FolderAfterFlatRow {
  type: "after";
  folderTreeId: TreeID;
  folderName: string;
  depth: number;
}

type FlatEntry = FlatRow | EmptyFlatRow | FolderAfterFlatRow;

const AFTER_DROP_PREFIX = "after-folder:";

const sidebarKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
    event.preventDefault();
    return {
      ...args.currentCoordinates,
      x: args.currentCoordinates.x + (event.code === "ArrowRight" ? 17.6 : -17.6),
    };
  }
  return sortableKeyboardCoordinates(event, args) ?? defaultKeyboardCoordinateGetter(event, args);
};

function afterDropId(treeId: TreeID): string {
  return `${AFTER_DROP_PREFIX}${treeId}`;
}

function folderIdFromAfterDropId(id: unknown): TreeID | undefined {
  return typeof id === "string" && id.startsWith(AFTER_DROP_PREFIX)
    ? (id.slice(AFTER_DROP_PREFIX.length) as TreeID)
    : undefined;
}

/**
 * Dnd-kit's closest-centre strategy is a poor fit for a tree: the centre of
 * a dragged row can remain closest to a folder heading even after the pointer
 * has crossed the folder's visible subtree. Use the pointer's vertical
 * position instead, with the explicit after-subtree markers winning when the
 * pointer is near one.
 */
const sidebarCollisionDetection: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
  pointerCoordinates,
}) => {
  const pointerY = pointerCoordinates?.y ?? collisionRect.top + collisionRect.height / 2;
  const pointerInsideRow = droppableContainers.some((container) => {
    const isAfterBoundary =
      typeof container.id === "string" && container.id.startsWith(AFTER_DROP_PREFIX);
    const rect = droppableRects.get(container.id);
    return !isAfterBoundary && Boolean(rect && pointerY >= rect.top && pointerY <= rect.bottom);
  });
  return droppableContainers
    .flatMap((container) => {
      const rect = droppableRects.get(container.id);
      if (!rect) return [];
      const isAfterBoundary = typeof container.id === "string" && container.id.startsWith(AFTER_DROP_PREFIX);
      const distance =
        pointerY < rect.top ? rect.top - pointerY : pointerY > rect.bottom ? pointerY - rect.bottom : 0;
      const boundaryDistance = Math.abs(pointerY - (rect.top + rect.height / 2));
      const value =
        isAfterBoundary && !pointerInsideRow && boundaryDistance <= 14
          ? -1000 + boundaryDistance
          : distance;
      return [{ id: container.id, data: { droppableContainer: container, value } }];
    })
    .sort((a, b) => {
      const valueDifference = (a.data?.value ?? 0) - (b.data?.value ?? 0);
      if (valueDifference !== 0) return valueDifference;
      const aIsAfter = typeof a.id === "string" && a.id.startsWith(AFTER_DROP_PREFIX);
      const bIsAfter = typeof b.id === "string" && b.id.startsWith(AFTER_DROP_PREFIX);
      return Number(aIsAfter) - Number(bIsAfter);
    });
};

function eventClientPoint(event: Event): { x: number; y: number } | undefined {
  const pointerEvent = event as MouseEvent;
  if (typeof pointerEvent.clientX === "number" && typeof pointerEvent.clientY === "number") {
    return { x: pointerEvent.clientX, y: pointerEvent.clientY };
  }
  const touchEvent = event as TouchEvent;
  if (touchEvent.changedTouches) {
    const touch = touchEvent.changedTouches[0];
    if (touch) return { x: touch.clientX, y: touch.clientY };
  }
  return undefined;
}

function flatten(
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

export { computeDropMode } from "./sidebar-dnd";

function findRow(rows: SidebarRow[], treeId: TreeID): SidebarRow | undefined {
  for (const row of rows) {
    if (row.treeId === treeId) return row;
    if (row.kind === "directory") {
      const found = findRow(row.children, treeId);
      if (found) return found;
    }
  }
  return undefined;
}

function countNotes(row: FolderRow): number {
  let n = 0;
  for (const child of row.children) {
    if (child.kind === "markdown") n += 1;
    else n += countNotes(child);
  }
  return n;
}

export function AppSidebar({
  rows,
  activeId,
  engine,
  onCreate,
  onCreateGraph,
  onCreateFolder,
  onSelect,
  onRenameNote,
  onDeleteNote,
  onRenameFolder,
  onDeleteFolder,
  onMove,
  onOpenCommandMenu,
  newFolderOpen,
  onNewFolderOpenChange,
}: AppSidebarProps) {
  const { setOpenMobile, isMobile, openMobile } = useSidebar();
  const [renameTarget, setRenameTarget] = useState<NoteRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NoteRow | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<FolderRow | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderRow | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<TreeID | undefined>(undefined);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);

  const toggleCollapsed = useCallback((treeId: TreeID) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(treeId)) next.delete(treeId);
      else next.add(treeId);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const expand = useCallback((treeId: TreeID) => {
    setCollapsed((prev) => {
      if (!prev.has(treeId)) return prev;
      const next = new Set(prev);
      next.delete(treeId);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const flat = useMemo(() => {
    const out: FlatEntry[] = [];
    flatten(rows, 0, undefined, collapsed, out);
    return out;
  }, [rows, collapsed]);

  const flatById = useMemo(() => {
    const map = new Map<string, FlatRow>();
    for (const f of flat) if (f.type === "row") map.set(f.row.treeId, f);
    return map;
  }, [flat]);

  const visibleDndRows = useMemo<VisibleDndRow[]>(
    () =>
      flat
        .filter((entry): entry is FlatRow => entry.type === "row")
        .map((entry) => ({
          treeId: entry.row.treeId,
          depth: entry.depth,
          parentTreeId: entry.parentTreeId,
          siblingIndex: entry.siblingIndex,
          kind: entry.row.kind,
        })),
    [flat],
  );

  const pick = (id: string) => {
    onSelect(id);
    setOpenMobile(false);
  };

  // --- drag and drop -----------------------------------------------------
  const [activeDragId, setActiveDragId] = useState<TreeID | null>(null);
  const activeDragIdRef = useRef<TreeID | null>(null);
  const [placement, setPlacement] = useState<SidebarPlacement | null>(null);
  const placementRef = useRef<SidebarPlacement | null>(null);
  const [dragAnnouncement, setDragAnnouncement] = useState("");
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoExpandTarget = useRef<TreeID | null>(null);
  const dragOrigin = useRef<{ baseX: number; grabOffsetX: number; indentPx: number } | null>(null);
  const keyboardDirection = useRef<"up" | "down" | null>(null);
  const keyboardTarget = useRef<TreeID | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement | null>(null);
  const latestPointerY = useRef<number | null>(null);
  const autoScrollFrame = useRef<number | null>(null);
  const latestDragEvent = useRef<DragOverEvent | DragMoveEvent | null>(null);
  const updateDropTargetRef = useRef<((event: DragOverEvent | DragMoveEvent) => void) | null>(null);
  const keyboardPointerX = useRef<number | null>(null);
  const keyboardPlacementRef = useRef<SidebarPlacement | null>(null);

  const sensors = useSensors(
    // Mouse: activate on a short drag distance so plain clicks (open note,
    // toggle folder) never get eaten by the drag gesture.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Touch: require a press-and-hold before dragging starts, so a tap still
    // opens a note and a finger-swipe still scrolls the sidebar list.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sidebarKeyboardCoordinates }),
  );

  const clearAutoExpand = () => {
    if (autoExpandTimer.current) {
      clearTimeout(autoExpandTimer.current);
      autoExpandTimer.current = null;
    }
    autoExpandTarget.current = null;
  };

  const stopAutoScroll = () => {
    if (autoScrollFrame.current !== null) {
      window.cancelAnimationFrame(autoScrollFrame.current);
      autoScrollFrame.current = null;
    }
  };

  const autoScrollSidebar = () => {
    if (!dragOrigin.current || latestPointerY.current === null) return;
    const content = sidebarContentRef.current;
    if (!content) return;
    const rect = content.getBoundingClientRect();
    const edge = Math.min(72, rect.height * 0.18);
    const distanceFromTop = latestPointerY.current - rect.top;
    const distanceFromBottom = rect.bottom - latestPointerY.current;
    let delta = 0;
    if (distanceFromTop >= 0 && distanceFromTop < edge) {
      delta = -Math.ceil((edge - distanceFromTop) / 5);
    } else if (distanceFromBottom >= 0 && distanceFromBottom < edge) {
      delta = Math.ceil((edge - distanceFromBottom) / 5);
    }
    if (delta !== 0) {
      content.scrollTop += delta;
      const event = latestDragEvent.current;
      if (event) updateDropTargetRef.current?.(event);
    }
    autoScrollFrame.current = window.requestAnimationFrame(autoScrollSidebar);
  };

  const startAutoScroll = () => {
    if (autoScrollFrame.current === null) {
      autoScrollFrame.current = window.requestAnimationFrame(autoScrollSidebar);
    }
  };

  const clearPlacement = () => {
    placementRef.current = null;
    setPlacement(null);
    setDragAnnouncement("");
  };

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = event.active.id as TreeID;
    const activeFlat = flatById.get(activeId);
    const initialRect = event.active.rect.current.initial;
    const indentPx =
      typeof document === "undefined"
        ? 17.6
        : (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) * 1.1;
    const point = eventClientPoint(event.activatorEvent);
    const baseX = initialRect?.left ?? 0;
    const contentLeft = baseX + (activeFlat?.depth ?? 0) * indentPx;
    dragOrigin.current = {
      baseX,
      indentPx,
      grabOffsetX: point ? point.x - contentLeft : 0,
    };
    keyboardPointerX.current = point?.x ?? contentLeft;
    latestPointerY.current = point?.y ?? initialRect?.top ?? null;
    activeDragIdRef.current = activeId;
    setActiveDragId(activeId);
    placementRef.current = null;
    keyboardPlacementRef.current = null;
    setPlacement(null);
    latestDragEvent.current = null;
    keyboardDirection.current = null;
    keyboardTarget.current = null;
    setDragAnnouncement(`Picked up ${getRowName(activeFlat?.row)}.`);
    startAutoScroll();
  };

  /**
   * dnd-kit only fires `onDragOver` when the *row* under the pointer
   * changes — not as you move within one row. Computing before/inside/after
   * there alone froze the drop mode at whatever it was when the row was
   * entered (usually "after"), so dropping onto a folder reordered instead
   * of moving into it. `onDragMove` fires continuously, so both handlers
   * run this.
   */
  const updateDropTarget = (event: DragOverEvent | DragMoveEvent) => {
    latestDragEvent.current = event;
    const { active, over } = event;
    const activeFlat = flatById.get(active.id as TreeID);
    const activeTranslated = active.rect.current.translated;
    const origin = dragOrigin.current;
    const initialPoint = eventClientPoint(event.activatorEvent);
    const pointer = initialPoint
      ? { x: initialPoint.x + event.delta.x, y: initialPoint.y + event.delta.y }
      : activeTranslated && origin
        ? {
            x: activeTranslated.left + (activeFlat?.depth ?? 0) * origin.indentPx + origin.grabOffsetX,
            y: activeTranslated.top + activeTranslated.height / 2,
          }
        : undefined;
    latestPointerY.current = pointer?.y ?? null;
    startAutoScroll();
    const keyboardTargetId =
      keyboardTarget.current ??
      (keyboardDirection.current ? placementRef.current?.targetTreeId : undefined);
    if (!over && !keyboardTargetId) {
      clearPlacement();
      clearAutoExpand();
      return;
    }
    const afterFolderId = keyboardTargetId ? undefined : folderIdFromAfterDropId(over?.id);
    const overTreeId = keyboardTargetId ?? afterFolderId ?? (over?.id as TreeID);
    const overFlat = flatById.get(overTreeId);
    if (!overFlat || !origin) return;

    const relative = keyboardDirection.current
      ? keyboardDirection.current === "up"
        ? 0.1
        : 0.9
      : pointer && over && over.rect.height > 0
        ? (pointer.y - over.rect.top) / over.rect.height
        : 0.5;
    const nextPlacement = resolveSidebarPlacement({
      rows,
      visibleRows: visibleDndRows,
      activeId: active.id as TreeID,
      targetTreeId: overTreeId,
      relativeY: relative,
      targetIsAfterBoundary: Boolean(afterFolderId),
      pointerX: keyboardTargetId ? keyboardPointerX.current ?? pointer?.x : pointer?.x,
      baseX: origin.baseX,
      grabOffsetX: origin.grabOffsetX,
      indentPx: origin.indentPx,
    });
    placementRef.current = nextPlacement;
    if (keyboardTargetId) keyboardPlacementRef.current = nextPlacement;
    setPlacement(nextPlacement);
    const activeName = getRowName(activeFlat?.row);
    setDragAnnouncement(`${activeName}. ${formatPlacementLabel(rows, nextPlacement, active.id as TreeID)}.`);

    if (
      nextPlacement.mode === "inside" &&
      overFlat.row.kind === "directory" &&
      collapsed.has(overTreeId)
    ) {
      if (autoExpandTarget.current !== overTreeId) {
        clearAutoExpand();
        autoExpandTarget.current = overTreeId;
        autoExpandTimer.current = setTimeout(() => {
          expand(overTreeId);
          const latestEvent = latestDragEvent.current;
          if (latestEvent) {
            window.requestAnimationFrame(() => updateDropTargetRef.current?.(latestEvent));
          }
        }, 600);
      }
    } else {
      clearAutoExpand();
    }
  };

  const handleDragOver = (event: DragOverEvent) => updateDropTarget(event);
  const handleDragMove = (event: DragMoveEvent) => updateDropTarget(event);
  useEffect(() => {
    updateDropTargetRef.current = updateDropTarget;
  }, [updateDropTarget]);

  const applyKeyboardPlacement = (targetTreeId: TreeID, direction: "up" | "down") => {
    const activeId = activeDragIdRef.current;
    const origin = dragOrigin.current;
    const targetFlat = flatById.get(targetTreeId);
    if (!activeId || !origin || !targetFlat) return;
    const nextPlacement = resolveSidebarPlacement({
      rows,
      visibleRows: visibleDndRows,
      activeId,
      targetTreeId,
      relativeY: direction === "up" ? 0.1 : 0.9,
      pointerX: keyboardPointerX.current ?? origin.baseX,
      baseX: origin.baseX,
      grabOffsetX: origin.grabOffsetX,
      indentPx: origin.indentPx,
    });
    placementRef.current = nextPlacement;
    keyboardPlacementRef.current = nextPlacement;
    setPlacement(nextPlacement);
    setDragAnnouncement(
      `${getRowName(flatById.get(activeId)?.row)}. ${formatPlacementLabel(rows, nextPlacement, activeId)}.`,
    );
  };

  const handleDragEnd = () => {
    clearAutoExpand();
    stopAutoScroll();
    const draggedId = activeDragIdRef.current ?? activeDragId;
    const currentPlacement = keyboardPlacementRef.current ?? placementRef.current;
    setActiveDragId(null);
    activeDragIdRef.current = null;
    dragOrigin.current = null;
    latestDragEvent.current = null;
    keyboardPointerX.current = null;
    keyboardPlacementRef.current = null;
    keyboardDirection.current = null;
    keyboardTarget.current = null;
    latestPointerY.current = null;
    clearPlacement();
    if (!draggedId || !currentPlacement) return;
    if (!currentPlacement.valid) {
      if (currentPlacement.reason === "descendant") {
        toast.error("Cannot move into own folder");
      }
      return;
    }
    if (currentPlacement.noOp) return;

    // Revalidate the exact placement against the latest tree. This protects
    // the commit if a remote sync or a folder expansion changed the tree
    // while dragging without losing an intentional horizontal depth choice.
    const revalidated = revalidateSidebarPlacement(rows, draggedId, currentPlacement);
    if (!revalidated.valid || revalidated.noOp) return;
    onMove({
      treeId: draggedId,
      newParent: revalidated.parentTreeId,
      index: revalidated.index,
    });
  };

  const handleDragCancel = () => {
    clearAutoExpand();
    stopAutoScroll();
    dragOrigin.current = null;
    latestDragEvent.current = null;
    keyboardPointerX.current = null;
    keyboardPlacementRef.current = null;
    latestPointerY.current = null;
    keyboardDirection.current = null;
    keyboardTarget.current = null;
    activeDragIdRef.current = null;
    setActiveDragId(null);
    clearPlacement();
  };

  useEffect(() => {
    if (isMobile && !openMobile && dragOrigin.current) handleDragCancel();
  }, [isMobile, openMobile]);

  useEffect(() => () => stopAutoScroll(), []);

  const draggedRow = activeDragId ? findRow(rows, activeDragId) : undefined;

  const isEmpty = rows.length === 0;

  // Create actions no-op before the vault engine holds the writer lock
  // (VaultApp's onCreate* guard on a missing engine/lock), so the buttons
  // that surface them stay disabled until writing is actually possible.
  const canWrite = Boolean(engine?.releaseWriterLock);

  return (
    <Sidebar variant="inset" className={activeDragId ? "select-none touch-none" : undefined}>
      <SidebarHeader className="flex-row items-center justify-between gap-2 px-4 pt-6 md:pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <img src="/icon.svg" alt="" className="size-6 shrink-0 rounded-md" />
          <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">Methyl</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-11 md:hidden"
            onClick={() => setOpenMobile(false)}
            aria-label="Close sidebar"
          >
            <X />
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setNewFolderParent(undefined);
                    onNewFolderOpenChange(true);
                  }}
                  aria-label="New folder"
                  className="size-11 text-muted-foreground md:size-8"
                  disabled={!canWrite}
                >
                  <FolderPlus />
                </Button>
              }
            />
            <TooltipContent>New folder</TooltipContent>
          </Tooltip>
          <CreateMenu
            onCreateNote={() => onCreate()}
            onCreateGraph={() => onCreateGraph()}
            disabled={!canWrite}
            className="size-11 text-muted-foreground md:size-8"
          />
        </div>
      </SidebarHeader>

      <SidebarContent ref={sidebarContentRef}>
        <SidebarGroup>
          <Button
            variant="ghost"
            className="mb-1 h-11 w-full justify-start gap-2 bg-sidebar-accent/40 px-2 font-normal text-muted-foreground hover:bg-sidebar-accent md:h-8"
            onClick={onOpenCommandMenu}
          >
            <Search className="text-muted-foreground" />
            Search notes
            <Kbd className="ml-auto">⌘K</Kbd>
          </Button>
          <SidebarGroupLabel className="px-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Notes
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {isEmpty ? (
              <Empty className="border-0 p-4">
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle className="text-sm">No notes yet</EmptyTitle>
              </Empty>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={sidebarCollisionDetection}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              >
                <SidebarMenu
                  className="gap-0.5"
                  onKeyDownCapture={(event) => {
                    const currentActiveId = activeDragIdRef.current;
                    if (!currentActiveId) return;
                    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
                      const targetTreeId =
                        keyboardTarget.current ?? placementRef.current?.targetTreeId;
                      if (!targetTreeId || !dragOrigin.current) return;
                      keyboardPointerX.current =
                        (keyboardPointerX.current ?? dragOrigin.current.baseX) +
                        (event.code === "ArrowRight"
                          ? dragOrigin.current.indentPx
                          : -dragOrigin.current.indentPx);
                      applyKeyboardPlacement(
                        targetTreeId,
                        keyboardDirection.current ?? "down",
                      );
                      return;
                    }
                    if (event.code !== "ArrowUp" && event.code !== "ArrowDown") return;
                    const referenceId = keyboardTarget.current ?? currentActiveId;
                    const referenceIndex = visibleDndRows.findIndex(
                      (entry) => entry.treeId === referenceId,
                    );
                    const step = event.code === "ArrowUp" ? -1 : 1;
                    const activeFolder = findRow(rows, currentActiveId);
                    let nextIndex = referenceIndex + step;
                    while (nextIndex >= 0 && nextIndex < visibleDndRows.length) {
                      const candidate = visibleDndRows[nextIndex];
                      const isOwnDescendant =
                        activeFolder?.kind === "directory" &&
                        findRow(activeFolder.children, candidate.treeId);
                      if (candidate.treeId !== currentActiveId && !isOwnDescendant) {
                        keyboardTarget.current = candidate.treeId;
                        keyboardDirection.current = event.code === "ArrowUp" ? "up" : "down";
                        keyboardPointerX.current ??= dragOrigin.current?.baseX ?? 0;
                        applyKeyboardPlacement(
                          candidate.treeId,
                          event.code === "ArrowUp" ? "up" : "down",
                        );
                        break;
                      }
                      nextIndex += step;
                    }
                  }}
                >
                  {flat.map((f) =>
                    f.type === "empty" ? (
                      <EmptyFolderRow key={f.key} depth={f.depth} />
                    ) : f.type === "after" ? (
                      <FolderAfterDropZone
                        key={afterDropId(f.folderTreeId)}
                        folderTreeId={f.folderTreeId}
                        folderName={f.folderName}
                        depth={f.depth}
                        placement={placement}
                      />
                    ) : (
                      <Row
                        key={f.row.treeId}
                        flat={f}
                        activeId={activeId}
                        isCollapsed={f.row.kind === "directory" && collapsed.has(f.row.treeId)}
                        onToggleCollapsed={toggleCollapsed}
                        onPick={pick}
                        placement={placement}
                        isDragging={activeDragId === f.row.treeId}
                        isDimmed={Boolean(
                          activeDragId &&
                            activeDragId !== f.row.treeId &&
                            findRow(
                              (draggedRow?.kind === "directory" ? draggedRow.children : []) ?? [],
                              f.row.treeId,
                            ),
                        )}
                        onCreateNote={onCreate}
                        onCreateFolder={(parent) => {
                          setNewFolderParent(parent);
                          onNewFolderOpenChange(true);
                        }}
                        onRenameNoteRequest={setRenameTarget}
                        onDeleteNoteRequest={setDeleteTarget}
                        onRenameFolderRequest={setRenameFolderTarget}
                        onDeleteFolderRequest={setDeleteFolderTarget}
                      />
                    ),
                  )}
                </SidebarMenu>
                <DragOverlay>
                  {draggedRow ? (
                    <div
                      data-sidebar-drag-preview="true"
                      data-sidebar-placement-depth={placement?.depth ?? ""}
                      className={cn(
                        "flex max-w-[min(22rem,calc(100vw-2rem))] flex-col gap-1 rounded-md border bg-sidebar px-3 py-2 text-sm shadow-lg",
                        "-translate-y-full motion-reduce:transition-none",
                      )}
                      style={{ paddingLeft: `${0.75 + (placement?.depth ?? 0) * 1.1}rem` }}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {draggedRow.kind === "directory" ? (
                          <Folder className="size-4 shrink-0" />
                        ) : draggedRow.isGraph ? (
                          <Workflow className="size-4 shrink-0" />
                        ) : (
                          <FileText className="size-4 shrink-0" />
                        )}
                        <span className="truncate font-medium">
                          {draggedRow.kind === "directory" ? draggedRow.name : draggedRow.title}
                        </span>
                        {draggedRow.kind === "directory" && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {countDescendants(draggedRow)} descendants
                          </span>
                        )}
                      </div>
                      {placement && (
                        <span
                          data-sidebar-placement-label="true"
                          className={cn("truncate text-xs", !placement.valid && "text-destructive")}
                        >
                          {formatPlacementLabel(rows, placement, activeDragId ?? undefined)}
                        </span>
                      )}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {dragAnnouncement}
      </div>

      <SidebarFooter className="flex-row items-center justify-between gap-2">
        <PwaStatus engine={engine} />
      </SidebarFooter>

      {renameTarget && (
        <RenameNoteDialog
          open={Boolean(renameTarget)}
          onOpenChange={(open) => !open && setRenameTarget(null)}
          currentTitle={renameTarget.title}
          onRename={(title) => onRenameNote(renameTarget.id, title)}
        />
      )}
      {deleteTarget && (
        <DeleteNoteAlert
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          noteTitle={deleteTarget.title}
          onConfirm={() => onDeleteNote(deleteTarget.id)}
        />
      )}
      {renameFolderTarget && (
        <RenameFolderDialog
          open={Boolean(renameFolderTarget)}
          onOpenChange={(open) => !open && setRenameFolderTarget(null)}
          currentName={renameFolderTarget.name}
          onRename={(name) => onRenameFolder(renameFolderTarget.treeId, name)}
        />
      )}
      {deleteFolderTarget && (
        <DeleteFolderAlert
          open={Boolean(deleteFolderTarget)}
          onOpenChange={(open) => !open && setDeleteFolderTarget(null)}
          folderName={deleteFolderTarget.name}
          noteCount={countNotes(deleteFolderTarget)}
          onConfirm={() => onDeleteFolder(deleteFolderTarget.treeId)}
        />
      )}
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={onNewFolderOpenChange}
        onCreate={(name) => onCreateFolder(newFolderParent, name)}
      />
    </Sidebar>
  );
}

interface RowProps {
  flat: FlatRow;
  activeId: string | null;
  isCollapsed: boolean;
  onToggleCollapsed: (treeId: TreeID) => void;
  onPick: (id: string) => void;
  placement: SidebarPlacement | null;
  isDragging: boolean;
  isDimmed: boolean;
  onCreateNote: (parentTreeId?: TreeID) => void;
  onCreateFolder: (parentTreeId?: TreeID) => void;
  onRenameNoteRequest: (row: NoteRow) => void;
  onDeleteNoteRequest: (row: NoteRow) => void;
  onRenameFolderRequest: (row: FolderRow) => void;
  onDeleteFolderRequest: (row: FolderRow) => void;
}

function Row({
  flat,
  activeId,
  isCollapsed,
  onToggleCollapsed,
  onPick,
  placement,
  isDragging,
  isDimmed,
  onCreateNote,
  onCreateFolder,
  onRenameNoteRequest,
  onDeleteNoteRequest,
  onRenameFolderRequest,
  onDeleteFolderRequest,
}: RowProps) {
  const { row, depth } = flat;
  const { attributes, listeners, setNodeRef: setDragRef } = useDraggable({
    id: row.treeId,
  });
  const { setNodeRef: setDropRef } = useDroppable({ id: row.treeId });

  const isTarget = placement?.targetTreeId === row.treeId;
  const showBefore = placement?.valid && isTarget && placement.mode === "before";
  const showAfter = placement?.valid && isTarget && placement.mode === "after" && row.kind !== "directory";
  const showInside = placement?.valid && isTarget && placement.mode === "inside" && row.kind === "directory";
  const isDestinationParent =
    placement?.valid && placement.parentTreeId === row.treeId && row.kind === "directory";

  const indent = { paddingLeft: `${depth * 1.1}rem` };

  const setRefs = (node: HTMLElement | null) => {
    setDragRef(node);
    setDropRef(node);
  };

  if (row.kind === "directory") {
    return (
      <SidebarMenuItem className="group/menu-item relative">
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                ref={setRefs}
                {...attributes}
                {...listeners}
                data-sidebar-drag-row="true"
                data-sidebar-drop-parent={isDestinationParent ? "true" : undefined}
                style={{ ...indent, touchAction: isDragging ? "none" : "pan-y" }}
                className={cn(
                  "relative rounded-md",
                  (isDragging || isDimmed) && "opacity-35",
                  showInside && "bg-sidebar-accent ring-1 ring-sidebar-ring",
                  isDestinationParent && "bg-sidebar-accent/70 ring-1 ring-sidebar-ring/70",
                )}
              >
                {depth > 0 && <IndentGuide depth={depth} />}
                {isDestinationParent && placement && <IndentGuide depth={placement.depth} />}
                <SidebarMenuButton
                  className={ROW_BUTTON}
                  aria-expanded={!isCollapsed}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onToggleCollapsed(row.treeId)}
                >
                  <ChevronRight
                    className={cn(
                      "text-muted-foreground transition-transform motion-reduce:transition-none",
                      !isCollapsed && "rotate-90",
                    )}
                  />
                  {isCollapsed ? <Folder /> : <FolderOpen />}
                  <span>{row.name}</span>
                </SidebarMenuButton>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuAction
                        showOnHover
                        onPointerDown={(event) => event.stopPropagation()}
                        className="top-1/2! -translate-y-1/2"
                        aria-label={`Actions for ${row.name}`}
                      >
                        <MoreHorizontal />
                      </SidebarMenuAction>
                    }
                  />
                  <DropdownMenuContent align="start" side="right">
                    <DropdownMenuItem onClick={() => onCreateNote(row.treeId)}>
                      <Plus data-icon="inline-start" />
                      New note
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onCreateFolder(row.treeId)}>
                      <FolderPlus data-icon="inline-start" />
                      New folder
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onRenameFolderRequest(row)}>
                      <Pencil data-icon="inline-start" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onDeleteFolderRequest(row)}
                    >
                      <Trash2 data-icon="inline-start" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            }
          />
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onCreateNote(row.treeId)}>
              <Plus data-icon="inline-start" />
              New note
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCreateFolder(row.treeId)}>
              <FolderPlus data-icon="inline-start" />
              New folder
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRenameFolderRequest(row)}>
              <Pencil data-icon="inline-start" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={() => onDeleteFolderRequest(row)}>
              <Trash2 data-icon="inline-start" />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {showBefore && <DropLine position="before" depth={placement?.depth ?? depth} />}
        {showAfter && <DropLine position="after" depth={placement?.depth ?? depth} />}
      </SidebarMenuItem>
    );
  }

  const note = row;
  return (
    <SidebarMenuItem className="group/menu-item relative">
      {showBefore && <DropLine position="before" depth={placement?.depth ?? depth} />}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              ref={setRefs}
              {...attributes}
              {...listeners}
              data-sidebar-drag-row="true"
              data-sidebar-drop-parent={isDestinationParent ? "true" : undefined}
              style={{ ...indent, touchAction: isDragging ? "none" : "pan-y" }}
              className={cn("relative rounded-md", (isDragging || isDimmed) && "opacity-35")}
            >
              {depth > 0 && <IndentGuide depth={depth} />}
              {isDestinationParent && placement && <IndentGuide depth={placement.depth} />}
              <SidebarMenuButton
                isActive={note.id === activeId}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onPick(note.id)}
                className={ROW_BUTTON}
              >
                {note.isGraph ? (
                  <Workflow className="text-muted-foreground" />
                ) : (
                  <FileText className="text-muted-foreground" />
                )}
                <span>{note.title}</span>
              </SidebarMenuButton>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuAction
                      showOnHover
                      onPointerDown={(event) => event.stopPropagation()}
                      className="top-1/2! -translate-y-1/2"
                      aria-label={`Actions for ${note.title}`}
                    >
                      <MoreHorizontal />
                    </SidebarMenuAction>
                  }
                />
                <DropdownMenuContent align="start" side="right">
                  <DropdownMenuItem onClick={() => onRenameNoteRequest(note)}>
                    <Pencil data-icon="inline-start" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => onDeleteNoteRequest(note)}
                  >
                    <Trash2 data-icon="inline-start" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onRenameNoteRequest(note)}>
            <Pencil data-icon="inline-start" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => onDeleteNoteRequest(note)}>
            <Trash2 data-icon="inline-start" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {showBefore && <DropLine position="before" depth={placement?.depth ?? depth} />}
      {showAfter && <DropLine position="after" depth={placement?.depth ?? depth} />}
    </SidebarMenuItem>
  );
}

function FolderAfterDropZone({
  folderTreeId,
  folderName,
  depth,
  placement,
}: {
  folderTreeId: TreeID;
  folderName: string;
  depth: number;
  placement: SidebarPlacement | null;
}) {
  const { setNodeRef } = useDroppable({ id: afterDropId(folderTreeId) });
  const isTarget = placement?.targetTreeId === folderTreeId;
  const showMarker =
    placement?.valid && isTarget && (placement.mode === "after" || placement.mode === "inside");
  const markerDepth = placement?.depth ?? depth;

  return (
    <li aria-hidden="true" className="relative h-px shrink-0">
      <div
        ref={setNodeRef}
        data-sidebar-drop-zone="after-folder"
        data-sidebar-drop-folder={folderName}
        className={cn(
          "absolute inset-x-2 -top-3 h-6 rounded-sm",
          isTarget && "bg-sidebar-ring/10",
        )}
      >
        {showMarker && <DropLine position="boundary" depth={markerDepth} />}
      </div>
    </li>
  );
}

/** Row height: comfortable touch target on mobile, compact on desktop. */
const ROW_BUTTON = "h-11 md:h-8";

function DropLine({
  position,
  depth,
}: {
  position: "before" | "after" | "boundary";
  depth: number;
}) {
  return (
    <div
      aria-hidden
      data-sidebar-drop-line="true"
      data-sidebar-drop-depth={depth}
      className="pointer-events-none absolute z-10 h-0.5 rounded-full bg-sidebar-ring"
      style={{
        left: `calc(0.5rem + ${depth * 1.1}rem)`,
        right: "0.5rem",
        ...(position === "before"
          ? { top: "-1px" }
          : position === "after"
            ? { bottom: "-1px" }
            : { top: "50%", transform: "translateY(-50%)" }),
      }}
    >
      <span className="absolute -left-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-sidebar bg-sidebar-ring" />
    </div>
  );
}

/** Subtle vertical guide aligned to the parent's indent, so nesting reads
 *  clearly at a glance. Purely decorative — sits behind row content. */
function IndentGuide({ depth }: { depth: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 border-l border-sidebar-border"
      style={{ left: `${depth * 1.1 - 0.55}rem` }}
    />
  );
}

function EmptyFolderRow({ depth }: { depth: number }) {
  return (
    <SidebarMenuItem className="relative">
      <div style={{ paddingLeft: `${depth * 1.1}rem` }} className="relative">
        <IndentGuide depth={depth} />
        <div className={cn(ROW_BUTTON, "flex items-center gap-2 px-2 text-sm text-muted-foreground")}>
          <span aria-hidden className="size-4 shrink-0" />
          <span className="italic">Empty</span>
        </div>
      </div>
    </SidebarMenuItem>
  );
}
