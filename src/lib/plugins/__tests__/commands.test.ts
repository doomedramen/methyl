import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "@/lib/plugins/commands";

describe("CommandRegistry", () => {
  it("namespaces commands as pluginId:id", () => {
    const registry = new CommandRegistry();
    registry.add("core-commands", { id: "new-note", name: "New note", callback: () => {} });
    const [cmd] = registry.list(null);
    expect(cmd.fullId).toBe("core-commands:new-note");
  });

  it("throws on duplicate full id", () => {
    const registry = new CommandRegistry();
    registry.add("core-commands", { id: "new-note", name: "New note", callback: () => {} });
    expect(() => registry.add("core-commands", { id: "new-note", name: "Dup", callback: () => {} })).toThrow(
      /core-commands:new-note/,
    );
  });

  it("excludes commands whose checkCallback(true) returns false", () => {
    const registry = new CommandRegistry();
    registry.add("p", { id: "a", name: "A", checkCallback: () => false });
    registry.add("p", { id: "b", name: "B", checkCallback: () => true });
    expect(registry.list(null).map((c) => c.fullId)).toEqual(["p:b"]);
  });

  it("excludes editorCallback commands when there is no active note", () => {
    const registry = new CommandRegistry();
    registry.add("p", { id: "edit", name: "Edit", editorCallback: () => {} });
    expect(registry.list(null)).toEqual([]);
    expect(registry.list({ documentId: "d1", isGraph: false })).toHaveLength(1);
  });

  it("execute calls the callback for a plain command", async () => {
    const registry = new CommandRegistry();
    const cb = vi.fn();
    registry.add("p", { id: "run", name: "Run", callback: cb });
    await registry.execute("p:run", null, null, vi.fn());
    expect(cb).toHaveBeenCalledOnce();
  });

  it("execute reports thrown errors via notify instead of throwing", async () => {
    const registry = new CommandRegistry();
    registry.add("p", {
      id: "boom",
      name: "Boom",
      callback: () => {
        throw new Error("kaboom");
      },
    });
    const notify = vi.fn();
    await expect(registry.execute("p:boom", null, null, notify)).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("kaboom"), "error");
  });

  it("a() disposer removes the command", () => {
    const registry = new CommandRegistry();
    const dispose = registry.add("p", { id: "a", name: "A", callback: () => {} });
    dispose();
    expect(registry.list(null)).toEqual([]);
  });
});
