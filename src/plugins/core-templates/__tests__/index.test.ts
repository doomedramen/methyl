import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import type { App } from "@/lib/plugins/api";
import { CoreTemplatesPlugin, CORE_TEMPLATES_MANIFEST } from "@/plugins/core-templates";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: () => {},
      toggleSidebar: () => {},
      openDialog: vi.fn(),
    },
    vault: {
      createNote: vi.fn(async () => "created-note"),
      createGraph: async () => "graph",
      createFolder: async () => {},
      read: async () => null,
      list: () => [],
    },
    notify: () => {},
  };
}

describe("CoreTemplatesPlugin", () => {
  it("loads empty by default and registers template commands", async () => {
    const app = makeApp();
    const commands = new CommandRegistry();
    const host = new PluginHost(app, new InMemoryPluginStorage(), commands);
    host.register(CORE_TEMPLATES_MANIFEST, CoreTemplatesPlugin);

    await host.enable("core-templates");

    const plugin = host.getPlugin("core-templates") as CoreTemplatesPlugin;
    expect(plugin.getTemplates()).toEqual([]);
    expect(commands.list(null).map((command) => command.fullId)).toEqual([
      "core-templates:manage",
      "core-templates:new-note",
    ]);
  });

  it("persists templates and restores them in a new host", async () => {
    const storage = new InMemoryPluginStorage();
    const app = makeApp();
    const host = new PluginHost(app, storage);
    host.register(CORE_TEMPLATES_MANIFEST, CoreTemplatesPlugin);
    await host.enable("core-templates");

    const plugin = host.getPlugin("core-templates") as CoreTemplatesPlugin;
    const created = await plugin.createTemplate("Meeting", "# Meeting\n\n- Attendees\n");
    expect(plugin.getTemplate(created.id)).toEqual(created);

    const restoredHost = new PluginHost(makeApp(), storage);
    restoredHost.register(CORE_TEMPLATES_MANIFEST, CoreTemplatesPlugin);
    await restoredHost.enable("core-templates");

    expect(restoredHost.getPlugin("core-templates")).toBeTruthy();
    expect((restoredHost.getPlugin("core-templates") as CoreTemplatesPlugin).getTemplates()).toEqual([created]);
  });

  it("creates a note with selected template content", async () => {
    const app = makeApp();
    const host = new PluginHost(app, new InMemoryPluginStorage());
    host.register(CORE_TEMPLATES_MANIFEST, CoreTemplatesPlugin);
    await host.enable("core-templates");
    const plugin = host.getPlugin("core-templates") as CoreTemplatesPlugin;
    const template = await plugin.createTemplate("Daily", "## Daily\n");

    await plugin.createNoteFromTemplate(template.id);

    expect(app.vault.createNote).toHaveBeenCalledWith({ markdown: "## Daily\n" });
  });

  it("notifies subscribers when templates change", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    host.register(CORE_TEMPLATES_MANIFEST, CoreTemplatesPlugin);
    await host.enable("core-templates");
    const plugin = host.getPlugin("core-templates") as CoreTemplatesPlugin;
    const listener = vi.fn();
    plugin.subscribe(listener);

    await plugin.createTemplate("One", "");
    await plugin.updateTemplate(plugin.getTemplates()[0].id, "Renamed", "body");
    await plugin.deleteTemplate(plugin.getTemplates()[0].id);

    expect(listener).toHaveBeenCalledTimes(3);
  });
});
