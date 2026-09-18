// @vitest-environment jsdom
import { StrictMode, useEffect, useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { PluginHostProvider, useApp, useCommands, usePluginStatuses } from "@/lib/plugins/react";
import { Plugin, type App, type NoteContext, type PluginManifest } from "@/lib/plugins/api";

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

function AppLabel() {
  const app = useApp();
  return <span>{app.workspace.getActiveNote()?.documentId ?? "none"}</span>;
}

const manifestA: PluginManifest = { id: "a", name: "A", version: "1.0.0", minAppVersion: "1.0.0", isCore: true };

class APlugin extends Plugin {
  onload() {
    this.addCommand({ id: "cmd", name: "A command", callback: () => {} });
  }
}

/**
 * Mirrors VaultPluginBridge's actual pattern (src/components/vault/
 * VaultApp.tsx): a `fallbackHost` with nothing registered is used until an
 * effect asynchronously builds and enables the real host, then swaps it in
 * via setState. Under StrictMode the effect (and its cleanup) run twice.
 */
function Bridge() {
  const commands = useMemo(() => new CommandRegistry(), []);
  const fallbackHost = useMemo(() => new PluginHost(makeApp(), new InMemoryPluginStorage()), []);
  const [host, setHost] = useState<PluginHost | null>(null);

  useEffect(() => {
    let cancelled = false;
    const newHost = new PluginHost(makeApp(), new InMemoryPluginStorage(), commands);
    newHost.register(manifestA, APlugin);
    void newHost.enableFromStorage().then(() => {
      if (!cancelled) setHost(newHost);
    });
    return () => {
      cancelled = true;
      newHost.dispose();
    };
  }, [commands]);

  return (
    <PluginHostProvider host={host ?? fallbackHost} commands={commands} app={makeApp()} activeNote={null}>
      <StatusList />
      <CommandList />
    </PluginHostProvider>
  );
}

describe("PluginHostProvider under StrictMode (host swaps from fallback to real)", () => {
  it("usePluginStatuses/useCommands pick up the real host's plugins and commands once it replaces the fallback", async () => {
    render(
      <StrictMode>
        <Bridge />
      </StrictMode>,
    );
    // Regression guard: a naive `!cacheRef.current` truthiness check treats
    // the fallback host's empty snapshot ([]) as "already cached" and never
    // re-reads after the swap to the real host, so this would otherwise
    // hang forever waiting for text that never appears.
    expect(await screen.findByText("enabled")).toBeTruthy();
    expect(await screen.findByText("A command")).toBeTruthy();
  });
});

describe("PluginHostProvider", () => {
  it("useApp exposes the app instance the provider was given, wired to the same activeNote", async () => {
    const note: NoteContext = { documentId: "note-42", isGraph: false };
    const app = makeApp();
    app.workspace.getActiveNote = () => note;
    render(
      <PluginHostProvider host={new PluginHost(makeApp(), new InMemoryPluginStorage())} commands={new CommandRegistry()} app={app} activeNote={note}>
        <AppLabel />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("note-42")).toBeTruthy();
  });

  it("passes the provider's activeNote through to useCommands (editorCallback commands are visible when a note is open)", async () => {
    const commands = new CommandRegistry();
    const editorCb = vi.fn();
    commands.add("p", { id: "edit", name: "Edit note", editorCallback: editorCb });
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    const note: NoteContext = { documentId: "note-1", isGraph: false };

    const { rerender } = render(
      <PluginHostProvider host={host} commands={commands} app={makeApp()} activeNote={null}>
        <CommandList />
      </PluginHostProvider>,
    );
    // No active note: editorCallback commands are filtered out (Task 3).
    expect(screen.queryByText("Edit note")).toBeNull();

    rerender(
      <PluginHostProvider host={host} commands={commands} app={makeApp()} activeNote={note}>
        <CommandList />
      </PluginHostProvider>,
    );
    expect(await screen.findByText("Edit note")).toBeTruthy();
  });

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
