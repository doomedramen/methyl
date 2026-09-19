import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_TAB_LIMIT,
  maxWorkspaceTabsForWidth,
  WORKSPACE_TAB_ACTIONS_WIDTH,
  WORKSPACE_TABBAR_PADDING,
  WORKSPACE_TAB_MIN_WIDTH,
} from "@/lib/workspace/tab-limit";

describe("maxWorkspaceTabsForWidth", () => {
  it("keeps one tab available on narrow screens", () => {
    expect(maxWorkspaceTabsForWidth(320)).toBe(1);
  });

  it("leaves room for mobile tab actions and close controls", () => {
    expect(
      maxWorkspaceTabsForWidth(
        WORKSPACE_TAB_ACTIONS_WIDTH + WORKSPACE_TABBAR_PADDING + WORKSPACE_TAB_MIN_WIDTH * 2,
      ),
    ).toBe(2);
  });

  it("uses a stable fallback for an unknown viewport", () => {
    expect(maxWorkspaceTabsForWidth(Number.NaN)).toBe(DEFAULT_WORKSPACE_TAB_LIMIT);
  });
});
