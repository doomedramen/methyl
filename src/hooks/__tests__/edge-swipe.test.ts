import { describe, expect, it } from "vitest";
import { shouldOpenEdgeSwipe } from "@/hooks/use-edge-swipe";

describe("shouldOpenEdgeSwipe", () => {
  it("accepts a horizontal swipe away from the left edge", () => {
    expect(
      shouldOpenEdgeSwipe({
        edge: "left",
        startX: 12,
        startY: 420,
        currentX: 72,
        currentY: 428,
        viewportWidth: 390,
      }),
    ).toBe(true);
  });

  it("accepts a horizontal swipe away from the right edge", () => {
    expect(
      shouldOpenEdgeSwipe({
        edge: "right",
        startX: 378,
        startY: 420,
        currentX: 318,
        currentY: 428,
        viewportWidth: 390,
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "starts away from the edge",
      startX: 100,
      currentX: 170,
      startY: 420,
      currentY: 428,
    },
    {
      name: "is mostly vertical",
      startX: 12,
      currentX: 72,
      startY: 420,
      currentY: 500,
    },
    {
      name: "does not clear the threshold",
      startX: 12,
      currentX: 48,
      startY: 420,
      currentY: 424,
    },
  ])("rejects when it $name", ({ startX, currentX, startY, currentY }) => {
    expect(
      shouldOpenEdgeSwipe({
        edge: "left",
        startX,
        startY,
        currentX,
        currentY,
        viewportWidth: 390,
      }),
    ).toBe(false);
  });
});
