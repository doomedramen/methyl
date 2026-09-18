import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "@/lib/plugins/host";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { CoreLivePreviewPlugin, CORE_LIVE_PREVIEW_MANIFEST } from "@/plugins/core-live-preview";
import type { App } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: vi.fn(),
      toggleSidebar: () => {},
      openDialog: () => {},
      resolveWikilink: () => undefined,
      createWikilinkTarget: () => {},
      getWikilinkCandidates: () => [],
    },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify: () => {},
  };
}

describe("CoreLivePreviewPlugin", () => {
  it("registers exactly one editor extension on load", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    host.register(CORE_LIVE_PREVIEW_MANIFEST, CoreLivePreviewPlugin);
    await host.enable("core-live-preview");
    expect(host.editorExtensions.getSnapshot()).toEqual([{ pluginId: "core-live-preview" }]);
  });

  it("disabling removes the registered extension", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    host.register(CORE_LIVE_PREVIEW_MANIFEST, CoreLivePreviewPlugin);
    await host.enable("core-live-preview");
    await host.disable("core-live-preview");
    expect(host.editorExtensions.getSnapshot()).toEqual([]);
  });
});
