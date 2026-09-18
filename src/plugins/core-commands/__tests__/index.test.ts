import { describe, expect, it, vi } from "vitest";
import { CoreCommandsPlugin, CORE_COMMANDS_MANIFEST } from "@/plugins/core-commands";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import type { App } from "@/lib/plugins/api";

function makeApp(overrides: Partial<App> = {}): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: () => {},
      toggleSidebar: vi.fn(),
      openDialog: vi.fn(),
    },
    vault: {
      createNote: vi.fn(async () => "id"),
      createGraph: vi.fn(async () => "id"),
      createFolder: vi.fn(async () => {}),
      read: async () => null,
      list: () => [],
    },
    notify: () => {},
    ...overrides,
  };
}

describe("CoreCommandsPlugin", () => {
  it("registers new-note, new-graph, new-folder, toggle-sidebar and sync-settings", async () => {
    const app = makeApp();
    const commands = new CommandRegistry();
    const host = new PluginHost(app, new InMemoryPluginStorage(), commands);
    host.register(CORE_COMMANDS_MANIFEST, CoreCommandsPlugin);
    await host.enable("core-commands");
    const ids = commands.list(null).map((c) => c.fullId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "core-commands:new-note",
        "core-commands:new-graph",
        "core-commands:new-folder",
        "core-commands:toggle-sidebar",
        "core-commands:sync-settings",
      ]),
    );
  });

  it("new-note command calls app.vault.createNote", async () => {
    const app = makeApp();
    const commands = new CommandRegistry();
    const host = new PluginHost(app, new InMemoryPluginStorage(), commands);
    host.register(CORE_COMMANDS_MANIFEST, CoreCommandsPlugin);
    await host.enable("core-commands");
    await commands.execute("core-commands:new-note", null, null, vi.fn());
    expect(app.vault.createNote).toHaveBeenCalledOnce();
  });
});
