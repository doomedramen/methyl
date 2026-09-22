// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { NoteEditor } from "@/components/editor/NoteEditor";
import { PluginHostProvider } from "@/lib/plugins/react";
import { forwardingApp } from "@/components/vault/VaultApp";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import type { App } from "@/lib/plugins/api";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Regression tests for e31e442 ("keep the editor and plugin App stable
 * across re-renders"). Before that fix, NoteEditor depended on the `app`
 * object VaultPluginBridge rebuilt on every active-note/save-state change,
 * so typing destroyed and recreated the CodeMirror view (dropped focus,
 * closed completions, reset undo). See
 * docs/superpowers/plans/2026-09-18-plugins-roadmap.md, Task A1.
 */

function makeApp(overrides: Partial<App> = {}): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: () => {},
      toggleSidebar: () => {},
      openDialog: () => {},
      setActiveEditorView: () => {},
      getActiveEditorView: () => null,
    },
    vault: { createNote: async () => "id", createGraph: async () => "id", createFolder: async () => {}, read: async () => null, list: () => [] },
    notify: () => {},
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-noteeditor-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeEngine() {
  return VaultEngine.create(new NodeVaultTreeStore(tmpDir), new NodeFSStore(tmpDir));
}

function Harness({ app, engine, documentId }: { app: App; engine: VaultEngine; documentId: string }) {
  const [host] = useState(() => new PluginHost(app, new InMemoryPluginStorage()));
  const [commands] = useState(() => new CommandRegistry());
  return (
    <PluginHostProvider host={host} commands={commands} app={app} activeNote={null}>
      <NoteEditor engine={engine} documentId={documentId} />
    </PluginHostProvider>
  );
}

describe("NoteEditor stability across re-renders", () => {
  it("keeps the same .cm-editor element and doc text when `app` changes identity", async () => {
    const engine = await makeEngine();
    const doc = engine.createDocument(undefined, "note.md", "hello world");

    const { container, rerender } = render(<Harness app={makeApp()} engine={engine} documentId={doc.id} />);

    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    const editorBefore = container.querySelector(".cm-editor");
    await waitFor(() => expect(container.querySelector(".cm-content")?.textContent).toContain("hello world"));

    // Simulate VaultPluginBridge rebuilding `app` (new identity) on an
    // active-note/save-state change.
    rerender(<Harness app={makeApp({ notify: () => {} })} engine={engine} documentId={doc.id} />);

    await waitFor(() => expect(container.querySelector(".cm-content")?.textContent).toContain("hello world"));
    const editorAfter = container.querySelector(".cm-editor");
    expect(editorAfter).toBe(editorBefore);
  });

  it("destroys CodeMirror before React removes its host", async () => {
    const engine = await makeEngine();
    const doc = engine.createDocument(undefined, "note.md", "hello world");
    const removedWhileMounted: boolean[] = [];
    const originalRemove = Element.prototype.remove;

    Element.prototype.remove = function remove(this: Element) {
      if (this.classList.contains("cm-editor")) {
        removedWhileMounted.push(this.isConnected);
      }
      originalRemove.call(this);
    };

    try {
      const { container, unmount } = render(
        <Harness app={makeApp()} engine={engine} documentId={doc.id} />,
      );

      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
      unmount();

      await waitFor(() => expect(removedWhileMounted).toHaveLength(1));
      expect(removedWhileMounted).toEqual([true]);
    } finally {
      Element.prototype.remove = originalRemove;
    }
  });

  it("loads content when the document arrives after its tree row", async () => {
    const engine = await makeEngine();
    const documentId = "remote-document-id";
    engine.tree.addMarkdownDocument(undefined, "remote.md", documentId);

    const { container } = render(
      <Harness app={makeApp()} engine={engine} documentId={documentId} />,
    );
    expect(container.textContent).toContain(`document not loaded: ${documentId}`);

    engine.ensureDocument(documentId).setText("content arrived from sync");

    await waitFor(() => {
      const content = container.querySelector(".cm-content");
      if (!content) throw new Error("editor has not booted");
      expect(content.textContent).toContain("content arrived from sync");
    });
  });
});

describe("forwardingApp identity stability", () => {
  function StableAppHarness({
    children,
    onRender,
  }: {
    children?: ReactNode;
    onRender: (app: App) => void;
  }) {
    const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
    // Re-derive appImpl every render, like VaultPluginBridge's `appImpl` useMemo
    // (which closes over the `activeNote` prop rather than a ref).
    const appImpl = useMemo(
      () =>
        makeApp({
          workspace: {
            ...makeApp().workspace,
            getActiveNote: () => (activeNoteId ? { documentId: activeNoteId, isGraph: false } : null),
          },
        }),
      [activeNoteId],
    );
    const appImplRef = useRef<App>(appImpl);
    useEffect(() => {
      appImplRef.current = appImpl;
    }, [appImpl]);
    // The ref is only dereferenced when a plugin calls a method, never during render.
    // eslint-disable-next-line react-hooks/refs
    const [stableApp] = useState(() => forwardingApp(appImplRef));
    onRender(stableApp);
    return (
      <div>
        <button onClick={() => setActiveNoteId("note-1")}>activate</button>
        <span data-testid="tick">{activeNoteId ?? ""}</span>
        {children}
      </div>
    );
  }

  it("returns the same App identity across re-renders while seeing fresh state", async () => {
    const seen: App[] = [];
    const { getByRole, getByTestId } = render(<StableAppHarness onRender={(app) => seen.push(app)} />);

    expect(seen.length).toBeGreaterThanOrEqual(1);
    const first = seen[0];
    expect(first.workspace.getActiveNote()).toBeNull();

    fireEvent.click(getByRole("button", { name: "activate" }));
    expect(getByTestId("tick").textContent).toBe("note-1");

    const latest = seen[seen.length - 1];
    // Same object identity — plugins that captured `app` on registration
    // still call through to the latest implementation.
    expect(latest).toBe(first);
    expect(first.workspace.getActiveNote()).toEqual({ documentId: "note-1", isGraph: false });
  });
});
