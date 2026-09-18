import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "@/lib/plugins/host";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { CoreWikilinksPlugin, CORE_WIKILINKS_MANIFEST } from "@/plugins/core-wikilinks";
import type { App } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: () => {},
      toggleSidebar: () => {},
      openDialog: () => {},
      resolveWikilink: () => undefined,
      createWikilinkTarget: () => {},
      getWikilinkCandidates: vi.fn(() => []),
    },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify: () => {},
  };
}

describe("CoreWikilinksPlugin", () => {
  it("registers exactly one completion source on load", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    host.register(CORE_WIKILINKS_MANIFEST, CoreWikilinksPlugin);
    await host.enable("core-wikilinks");
    // EditorExtensionRegistry tracks completion sources separately from
    // extensions; buildExtension() must not throw with the source present.
    expect(() => host.editorExtensions.buildExtension()).not.toThrow();
  });
});
