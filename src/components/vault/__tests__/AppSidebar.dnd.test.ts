import { describe, expect, it } from "vitest";
import { computeDropMode } from "../AppSidebar";

describe("computeDropMode", () => {
  describe("directory rows (wide 50% inside band)", () => {
    it("is before just above the top quarter", () => {
      expect(computeDropMode(0.24, true)).toBe("before");
    });

    it("is inside right at the top boundary", () => {
      expect(computeDropMode(0.25, true)).toBe("inside");
    });

    it("is inside at the center", () => {
      expect(computeDropMode(0.5, true)).toBe("inside");
    });

    it("is inside right at the bottom boundary", () => {
      expect(computeDropMode(0.75, true)).toBe("inside");
    });

    it("is after just below the bottom quarter", () => {
      expect(computeDropMode(0.76, true)).toBe("after");
    });
  });

  describe("note rows (simple before/after split)", () => {
    it("is before in the top half", () => {
      expect(computeDropMode(0.1, false)).toBe("before");
      expect(computeDropMode(0.49, false)).toBe("before");
    });

    it("is after at and below the midpoint", () => {
      expect(computeDropMode(0.5, false)).toBe("after");
      expect(computeDropMode(0.9, false)).toBe("after");
    });
  });
});
