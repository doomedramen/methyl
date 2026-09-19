import { describe, expect, it } from "vitest";
import { rankQuickSwitcher, type QuickSwitcherEntry } from "@/lib/workspace/quick-switcher";

const entries: QuickSwitcherEntry[] = [
  { id: "one", title: "Project Plan", path: "Projects/Project Plan.md" },
  { id: "two", title: "Personal Log", path: "Personal/Personal Log.md" },
  { id: "three", title: "Ideas", path: "Ideas/Planning Ideas.md" },
];

describe("rankQuickSwitcher", () => {
  it("prioritizes title matches over path-only matches", () => {
    expect(rankQuickSwitcher(entries, "plan").map((entry) => entry.id)).toEqual(["one", "three"]);
  });

  it("uses recent documents as the tie-breaker for an empty query", () => {
    expect(rankQuickSwitcher(entries, "", ["three", "one"]).map((entry) => entry.id)).toEqual([
      "three",
      "one",
      "two",
    ]);
  });

  it("supports fuzzy title/path matching and a result limit", () => {
    expect(rankQuickSwitcher(entries, "ppl", [], 1)).toHaveLength(1);
    expect(rankQuickSwitcher(entries, "ppl")[0]?.id).toBe("one");
  });
});
