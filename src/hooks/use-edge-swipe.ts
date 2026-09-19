"use client";

import { useEffect, useRef } from "react";

export type EdgeSwipe = "left" | "right";

export interface EdgeSwipeSample {
  edge: EdgeSwipe;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  viewportWidth: number;
  edgeSize?: number;
  threshold?: number;
}

const DEFAULT_EDGE_SIZE = 24;
const DEFAULT_THRESHOLD = 48;

/**
 * Decide whether a pointer movement is an intentional edge-open gesture.
 * Keep this pure so the gesture contract stays testable without a browser.
 */
export function shouldOpenEdgeSwipe({
  edge,
  startX,
  startY,
  currentX,
  currentY,
  viewportWidth,
  edgeSize = DEFAULT_EDGE_SIZE,
  threshold = DEFAULT_THRESHOLD,
}: EdgeSwipeSample): boolean {
  const startsAtEdge = edge === "left"
    ? startX <= edgeSize
    : startX >= viewportWidth - edgeSize;
  const horizontalDistance = edge === "left"
    ? currentX - startX
    : startX - currentX;
  const verticalDistance = Math.abs(currentY - startY);

  return (
    startsAtEdge &&
    horizontalDistance >= threshold &&
    horizontalDistance > verticalDistance * 1.2
  );
}

interface UseEdgeSwipeToOpenOptions {
  edge: EdgeSwipe;
  enabled: boolean;
  onOpen: () => void;
  edgeSize?: number;
  threshold?: number;
}

/**
 * Listen for a touch/pen swipe that starts at one viewport edge and open a
 * side sheet. Mouse drags and gestures that begin in the main content stay
 * untouched, preserving scrolling, dragging, and browser/system gestures.
 */
export function useEdgeSwipeToOpen({
  edge,
  enabled,
  onOpen,
  edgeSize = DEFAULT_EDGE_SIZE,
  threshold = DEFAULT_THRESHOLD,
}: UseEdgeSwipeToOpenOptions): void {
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    if (!enabled) return;

    let gesture: {
      pointerId: number;
      startX: number;
      startY: number;
    } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || (event.pointerType !== "touch" && event.pointerType !== "pen")) {
        return;
      }

      const startsAtEdge = edge === "left"
        ? event.clientX <= edgeSize
        : event.clientX >= window.innerWidth - edgeSize;
      if (!startsAtEdge) return;

      gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;

      const horizontalDistance = edge === "left"
        ? event.clientX - gesture.startX
        : gesture.startX - event.clientX;
      const verticalDistance = Math.abs(event.clientY - gesture.startY);

      // Abandon a gesture once it is clearly vertical or moving back into
      // the edge. This keeps the sidebar's scroll and the editor's gestures
      // from being captured by a horizontal drawer affordance.
      if (horizontalDistance < 0 || verticalDistance > horizontalDistance + 8) {
        gesture = null;
        return;
      }

      if (
        shouldOpenEdgeSwipe({
          edge,
          startX: gesture.startX,
          startY: gesture.startY,
          currentX: event.clientX,
          currentY: event.clientY,
          viewportWidth: window.innerWidth,
          edgeSize,
          threshold,
        })
      ) {
        gesture = null;
        onOpenRef.current();
      }
    };

    const clearGesture = (event: PointerEvent) => {
      if (!gesture || event.pointerId === gesture.pointerId) gesture = null;
    };

    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", clearGesture, { passive: true });
    window.addEventListener("pointercancel", clearGesture, { passive: true });

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", clearGesture);
      window.removeEventListener("pointercancel", clearGesture);
    };
  }, [edge, edgeSize, enabled, threshold]);
}
