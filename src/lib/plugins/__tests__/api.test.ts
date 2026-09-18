import { describe, expect, it, vi } from "vitest";
import { API_VERSION, Plugin, type App, type PluginManifest } from "@/lib/plugins/api";

const noopApp: App = {
  commands: { list: () => [], execute: () => {} },
  workspace: {
    getActiveNote: () => null,
    openNote: () => {},
    toggleSidebar: () => {},
    openDialog: () => {},
  },
  vault: {
    createNote: async () => "id",
    createGraph: async () => "id",
    createFolder: async () => {},
    read: async () => null,
    list: () => [],
  },
  notify: () => {},
};

class TestPlugin extends Plugin {
  onload = vi.fn();
  onunload = vi.fn();
}

describe("Plugin base class", () => {
  it("exposes app and manifest passed to the constructor", () => {
    const manifest: PluginManifest = { id: "test", name: "Test", version: "1.0.0", minAppVersion: "1.0.0" };
    const plugin = new TestPlugin(noopApp, manifest);
    expect(plugin.app).toBe(noopApp);
    expect(plugin.manifest).toBe(manifest);
  });

  it("default addCommand returns the command unchanged", () => {
    const manifest: PluginManifest = { id: "test", name: "Test", version: "1.0.0", minAppVersion: "1.0.0" };
    const plugin = new TestPlugin(noopApp, manifest);
    const cmd = { id: "cmd", name: "Cmd", callback: () => {} };
    expect(plugin.addCommand(cmd)).toBe(cmd);
  });

  it("default loadData resolves null", async () => {
    const manifest: PluginManifest = { id: "test", name: "Test", version: "1.0.0", minAppVersion: "1.0.0" };
    const plugin = new TestPlugin(noopApp, manifest);
    await expect(plugin.loadData()).resolves.toBeNull();
  });

  it("exports a semver API_VERSION", () => {
    expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
