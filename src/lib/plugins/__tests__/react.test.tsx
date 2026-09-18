// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { PluginHostProvider, useCommands, usePluginStatuses } from "@/lib/plugins/react";
import { Plugin, type App } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: { getActiveNote: () => null, openNote: () => {}, toggleSidebar: () => {}, openDialog: () => {} },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify: () => {},
  };
}

function CommandList() {
  const commands = useCommands();
  return <ul>{commands.map((c) => <li key={c.fullId}>{c.name}</li>)}</ul>;
}

function StatusList() {
  const statuses = usePluginStatuses();
  return <ul>{statuses.map((s) => <li key={s.manifest.id}>{s.state}</li>)}</ul>;
}

describe("PluginHostProvider", () => {
  it("useCommands reflects the CommandRegistry", async () => {
    const commands = new CommandRegistry();
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    commands.add("p", { id: "cmd", name: "Do thing", callback: () => {} });
    render(
      <PluginHostProvider host={host} commands={commands} app={makeApp()} activeNote={null}>
        <CommandList />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("Do thing")).toBeTruthy();
  });

  it("usePluginStatuses reflects host state changes", async () => {
    const commands = new CommandRegistry();
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    class A extends Plugin {}
    host.register({ id: "a", name: "A", version: "1.0.0", minAppVersion: "1.0.0" }, A);
    render(
      <PluginHostProvider host={host} commands={commands} app={makeApp()} activeNote={null}>
        <StatusList />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("disabled")).toBeTruthy();
    await act(async () => {
      await host.enable("a");
    });
    expect(await screen.findByText("enabled")).toBeTruthy();
  });
});
