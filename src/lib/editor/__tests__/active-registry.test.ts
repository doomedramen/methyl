import { describe, expect, it } from "vitest";
import { ActiveEditorRegistry } from "@/lib/editor/active-registry";

describe("ActiveEditorRegistry", () => {
  it("tracks the focused view independently for each tab", () => {
    const registry = new ActiveEditorRegistry();
    const first = {} as import("@codemirror/view").EditorView;
    const second = {} as import("@codemirror/view").EditorView;

    registry.set("tab-a", first);
    registry.set("tab-b", second);
    expect(registry.getFocused()).toBe(second);
    expect(registry.get("tab-a")).toBe(first);

    registry.focus("tab-a");
    expect(registry.getFocused()).toBe(first);
    registry.set("tab-a", null);
    expect(registry.getFocused()).toBeNull();
  });
});
