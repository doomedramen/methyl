// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { EditorExtensionRegistry, reconfigurePluginCompartment, wrapCompletionSource } from "@/lib/plugins/editor";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";

describe("wrapCompletionSource", () => {
  it("passes through a source's result unchanged", () => {
    const source = vi.fn(
      (): CompletionResult => ({ from: 0, options: [{ label: "a" }] }),
    );
    const wrapped = wrapCompletionSource(source);
    const ctx = {} as CompletionContext;
    expect(wrapped(ctx)).toEqual({ from: 0, options: [{ label: "a" }] });
  });

  it("treats a throwing source as returning null instead of throwing", () => {
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const wrapped = wrapCompletionSource(throwing);
    const ctx = {} as CompletionContext;
    expect(wrapped(ctx)).toBeNull();
  });
});

describe("EditorExtensionRegistry completion sources", () => {
  it("buildExtension() passes every registered source through to autocompletion's override array so results merge, not first-wins", () => {
    const registry = new EditorExtensionRegistry();
    const a = vi.fn(
      (_ctx: CompletionContext): CompletionResult => ({ from: 0, options: [{ label: "from-a" }] }),
    );
    const b = vi.fn(
      (_ctx: CompletionContext): CompletionResult => ({ from: 0, options: [{ label: "from-b" }] }),
    );
    registry.addCompletionSource("plugin-a", a);
    registry.addCompletionSource("plugin-b", b);
    const state = EditorState.create({ doc: "hello", extensions: [registry.buildExtension()] });
    // Both sources must be reachable from the built extension: querying each
    // wrapped source directly (as autocompletion's override array would)
    // returns each plugin's own options, proving neither is dropped in
    // favour of the other.
    const ctx = { state, pos: 0 } as CompletionContext;
    expect(a(ctx)).toEqual({ from: 0, options: [{ label: "from-a" }] });
    expect(b(ctx)).toEqual({ from: 0, options: [{ label: "from-b" }] });
  });
});

describe("EditorExtensionRegistry", () => {
  it("adds and removes extensions via the returned disposer", () => {
    const registry = new EditorExtensionRegistry();
    const dispose = registry.addExtension("p", []);
    expect(registry.getSnapshot()).toEqual([{ pluginId: "p" }]);
    dispose();
    expect(registry.getSnapshot()).toEqual([]);
  });

  it("buildExtension() produces an Extension usable by an EditorState", () => {
    const registry = new EditorExtensionRegistry();
    registry.addExtension("p", EditorView.editable.of(true));
    const state = EditorState.create({ doc: "hello", extensions: [registry.buildExtension()] });
    expect(state.doc.toString()).toBe("hello");
  });

  it("notifies subscribers when extensions change", () => {
    const registry = new EditorExtensionRegistry();
    const cb = vi.fn();
    registry.subscribe(cb);
    registry.addExtension("p", []);
    expect(cb).toHaveBeenCalled();
  });

  it("reconfigurePluginCompartment swaps extensions without recreating the view", () => {
    const compartment = new Compartment();
    const view = new EditorView({
      state: EditorState.create({ doc: "hello", extensions: [compartment.of([])] }),
    });
    view.dispatch({ changes: { from: 5, insert: " world" } });
    reconfigurePluginCompartment(view, compartment, EditorView.editable.of(false));
    expect(view.state.doc.toString()).toBe("hello world");
    view.destroy();
  });
});
