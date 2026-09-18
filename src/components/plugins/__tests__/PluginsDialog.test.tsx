// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PluginsDialog } from "@/components/plugins/PluginsDialog";
import { PluginHostProvider } from "@/lib/plugins/react";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { Plugin, type App } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: { getActiveNote: () => null, openNote: () => {}, toggleSidebar: () => {}, openDialog: () => {}, resolveWikilink: () => undefined, createWikilinkTarget: () => {}, getWikilinkCandidates: () => [] },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify: () => {},
  };
}

describe("PluginsDialog", () => {
  it("lists registered plugins with their state", async () => {
    const app = makeApp();
    const host = new PluginHost(app, new InMemoryPluginStorage());
    class A extends Plugin {}
    host.register({ id: "a", name: "Plugin A", description: "Does things", version: "1.0.0", minAppVersion: "1.0.0" }, A);
    render(
      <PluginHostProvider host={host} commands={new CommandRegistry()} app={app} activeNote={null}>
        <PluginsDialog open={true} onOpenChange={vi.fn()} />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("Plugin A")).toBeTruthy();
    expect(await screen.findByText("disabled")).toBeTruthy();
  });

  it("shows the error message for a failed plugin", async () => {
    const app = makeApp();
    const host = new PluginHost(app, new InMemoryPluginStorage());
    class Bad extends Plugin {
      onload() {
        throw new Error("bad config");
      }
    }
    host.register({ id: "bad", name: "Bad Plugin", version: "1.0.0", minAppVersion: "1.0.0" }, Bad);
    await host.enable("bad");
    render(
      <PluginHostProvider host={host} commands={new CommandRegistry()} app={app} activeNote={null}>
        <PluginsDialog open={true} onOpenChange={vi.fn()} />
      </PluginHostProvider>,
    );
    expect(await screen.findByText(/bad config/)).toBeTruthy();
  });
});
