import { describe, expect, it, vi } from "vitest";
import { HotkeyManager, formatHotkey, matchesEvent } from "@/lib/plugins/hotkeys";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";

describe("formatHotkey", () => {
  it("renders Mod as ⌘ on mac and Ctrl elsewhere", () => {
    const hotkey = { modifiers: ["Mod" as const], key: "k" };
    expect(formatHotkey(hotkey, "mac")).toBe("⌘+K");
    expect(formatHotkey(hotkey, "other")).toBe("Ctrl+K");
  });
});

describe("matchesEvent", () => {
  it("matches Mod against metaKey on mac and ctrlKey elsewhere", () => {
    const hotkey = { modifiers: ["Mod" as const], key: "k" };
    expect(matchesEvent(hotkey, { key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "mac")).toBe(true);
    expect(matchesEvent(hotkey, { key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, "other")).toBe(true);
    expect(matchesEvent(hotkey, { key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, "mac")).toBe(false);
  });
});

describe("HotkeyManager", () => {
  it("returns the default hotkey when there is no override", async () => {
    const manager = new HotkeyManager(new InMemoryPluginStorage());
    await manager.loadOverrides();
    manager.setDefault("p:cmd", [{ modifiers: ["Mod"], key: "k" }]);
    expect(manager.getEffective("p:cmd")).toEqual([{ modifiers: ["Mod"], key: "k" }]);
  });

  it("a user override in hotkeys.json beats the default", async () => {
    const storage = new InMemoryPluginStorage();
    await storage.write(
      ".adhd/hotkeys.json",
      new TextEncoder().encode(JSON.stringify({ "p:cmd": [{ modifiers: ["Mod", "Shift"], key: "k" }] })),
    );
    const manager = new HotkeyManager(storage);
    await manager.loadOverrides();
    manager.setDefault("p:cmd", [{ modifiers: ["Mod"], key: "k" }]);
    expect(manager.getEffective("p:cmd")).toEqual([{ modifiers: ["Mod", "Shift"], key: "k" }]);
  });

  it("an empty array override unbinds the command", async () => {
    const storage = new InMemoryPluginStorage();
    await storage.write(".adhd/hotkeys.json", new TextEncoder().encode(JSON.stringify({ "p:cmd": [] })));
    const manager = new HotkeyManager(storage);
    await manager.loadOverrides();
    manager.setDefault("p:cmd", [{ modifiers: ["Mod"], key: "k" }]);
    expect(manager.getEffective("p:cmd")).toEqual([]);
  });

  it("warns and returns only the last-registered match on conflict", async () => {
    const manager = new HotkeyManager(new InMemoryPluginStorage());
    await manager.loadOverrides();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    manager.setDefault("p:first", [{ modifiers: ["Mod"], key: "k" }]);
    manager.setDefault("p:second", [{ modifiers: ["Mod"], key: "k" }]);
    const matched = manager.handleKeydown(
      { key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent,
      "mac",
    );
    expect(matched).toEqual(["p:second"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
