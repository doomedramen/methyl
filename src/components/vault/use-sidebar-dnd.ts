"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TreeID } from "loro-crdt";
import {
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
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
import {
  formatPlacementLabel,
  getRowName,
  revalidateSidebarPlacement,
  resolveSidebarPlacement,
  type SidebarPlacement,
  type VisibleDndRow,
} from "./sidebar-dnd";
import {
  AFTER_DROP_PREFIX,
  findRow,
  folderIdFromAfterDropId,
  type FlatRow,
  type MoveTarget,
  type SidebarRow,
} from "./sidebar-rows";

/**
 * Drag and drop in the sidebar tree: pointer, touch and keyboard moves,
 * placement (before / inside / after, and depth by horizontal position),
 * auto-expanding folders, auto-scrolling, and the screen-reader
 * announcements. The placement rules themselves are in sidebar-dnd.ts.
 */

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

/**
 * Dnd-kit's closest-centre strategy is a poor fit for a tree: the centre of
 * a dragged row can remain closest to a folder heading even after the pointer
 * has crossed the folder's visible subtree. Use the pointer's vertical
 * position instead, with the explicit after-subtree markers winning when the
 * pointer is near one.
 */
export const sidebarCollisionDetection: CollisionDetection = ({
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

export function useSidebarDnd({
  rows,
  flatById,
  visibleDndRows,
  collapsed,
  expand,
  onMove,
  isMobile,
  openMobile,
}: {
  rows: SidebarRow[];
  flatById: Map<string, FlatRow>;
  visibleDndRows: VisibleDndRow[];
  collapsed: Set<string>;
  expand: (treeId: TreeID) => void;
  onMove: (target: MoveTarget) => void;
  isMobile: boolean;
  openMobile: boolean;
}) {
  const [activeDragId, setActiveDragId] = useState<TreeID | null>(null);
  const [dndContextKey, setDndContextKey] = useState(0);
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
  // Runs after every render so the ref always holds this render's closure.
  useEffect(() => {
    updateDropTargetRef.current = updateDropTarget;
  });

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

  // KeyboardSensor installs its document listener asynchronously. Under load,
  // the second Space can reach the row while that listener is between mounts.
  // Give the sensor a chance to finish normally, then recover the visible
  // placement and reset the context if it did not.
  const scheduleKeyboardDropFallback = () => {
    const expectedActiveId = activeDragIdRef.current;
    if (!expectedActiveId) return;
    window.setTimeout(() => {
      if (activeDragIdRef.current !== expectedActiveId) return;
      handleDragEnd();
      setDndContextKey((key) => key + 1);
    }, 50);
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

  const handleDragCancelRef = useRef(handleDragCancel);
  useEffect(() => {
    handleDragCancelRef.current = handleDragCancel;
  });
  useEffect(() => {
    if (isMobile && !openMobile && dragOrigin.current) handleDragCancelRef.current();
  }, [isMobile, openMobile]);

  useEffect(() => () => stopAutoScroll(), []);

  const draggedRow = activeDragId ? findRow(rows, activeDragId) : undefined;

  /** Arrow keys move the keyboard-dragged row; Space drops it (with a fallback). */
  const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    const currentActiveId = activeDragIdRef.current;
    if (!currentActiveId) return;
    if (event.code === "Space" && !event.repeat) {
      scheduleKeyboardDropFallback();
      return;
    }
    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      const targetTreeId =
        keyboardTarget.current ?? placementRef.current?.targetTreeId;
      if (!targetTreeId || !dragOrigin.current) return;
      keyboardPointerX.current =
        (keyboardPointerX.current ?? dragOrigin.current.baseX) +
        (event.code === "ArrowRight"
          ? dragOrigin.current.indentPx
          : -dragOrigin.current.indentPx);
      const targetRow = findRow(rows, targetTreeId);
      const direction =
        event.code === "ArrowRight" && targetRow?.kind === "directory"
          ? "down"
          : keyboardDirection.current ?? "down";
      keyboardDirection.current = direction;
      applyKeyboardPlacement(
        targetTreeId,
        direction,
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
  };

  return {
    sensors,
    dndContextKey,
    activeDragId,
    draggedRow,
    placement,
    dragAnnouncement,
    sidebarContentRef,
    handleDragStart,
    handleDragOver,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
    handleKeyDownCapture,
  };
}
