import { describe, it, expect } from "vitest";
import { LoroDoc } from "loro-crdt";
import { CONTENT_KEY } from "@/lib/core/document";

/**
 * loro-codemirror's package.json only declares "." in its exports map, so
 * a bare-specifier import of the internal sync module is refused by
 * Node's resolver. Importing the on-disk file directly bypasses that
 * (the exports map only gates package-name resolution, not file paths),
 * which is what lets this test exercise the exact vendored code that
 * production hits — no local reimplementation to drift from the real bug.
 */
async function loadLoroSyncPluginValue() {
  const url = new URL(
    "../../../../node_modules/loro-codemirror/dist/sync.js",
    import.meta.url,
  );
  const mod = (await import(url.href)) as {
    LoroSyncPluginValue: new (
      view: FakeView,
      doc: LoroDoc,
      getTextFromDoc: (doc: LoroDoc) => ReturnType<LoroDoc["getText"]>,
    ) => { update: (u: FakeViewUpdate) => void };
  };
  return mod.LoroSyncPluginValue;
}

/**
 * Minimal stand-in for CodeMirror's EditorView/ViewUpdate — only the
 * surface LoroSyncPluginValue actually touches (confirmed by reading
 * node_modules/loro-codemirror/dist/sync.js): `view.state.doc.length`/
 * `.toString()`, `view.dispatch(...)`, and on `update()`:
 * `update.docChanged`, `update.transactions[0].annotation(...)`,
 * `update.changes.iterChanges(...)`. No jsdom/real EditorView needed.
 */
class FakeDoc {
  constructor(public text: string) {}
  toString() {
    return this.text;
  }
  get length() {
    return this.text.length;
  }
}
class FakeView {
  state = { doc: new FakeDoc("") };
  dispatch(_spec: unknown) {
    // Real EditorView.dispatch would run the transaction through the
    // state and then notify plugins' update(); the test drives that
    // second half itself by calling pluginValue.update(...) after
    // mutating state.doc, mirroring what a real dispatch does.
  }
}
interface FakeViewUpdate {
  docChanged: boolean;
  transactions: { annotation: (t: unknown) => unknown }[];
  changes: { iterChanges: (cb: (fromA: number, toA: number, fromB: number, toB: number, insert: { sliceString: (a: number, b: number, sep: string) => string }) => void) => void };
}

function bulkInsertUpdate(text: string): FakeViewUpdate {
  return {
    docChanged: true,
    transactions: [{ annotation: () => undefined }],
    changes: {
      iterChanges: (cb) => {
        cb(0, 0, 0, text.length, { sliceString: () => text });
      },
    },
  };
}

// Upstream report: docs/upstream/loro-codemirror-first-edit.md. The first
// test asserts the bug on purpose: when it fails, upstream has fixed it —
// remove the warm-up dispatch in NoteEditor.tsx and this file.
describe("loro-codemirror LoroSyncPluginValue: first-update swallow (vendored bug)", () => {
  it("without a warm-up dispatch, the user's first bulk insert never reaches the LoroText", async () => {
    const LoroSyncPluginValue = await loadLoroSyncPluginValue();
    const doc = new LoroDoc();
    const getText = (d: LoroDoc) => d.getText(CONTENT_KEY);
    const view = new FakeView();

    const plugin = new LoroSyncPluginValue(view, doc, getText);
    // The constructor's `isInitDispatch = true` happens inside a
    // Promise.resolve().then(...) microtask — let it run, exactly as it
    // would before any real (later) user keystroke.
    await Promise.resolve();
    await Promise.resolve();

    // The user's first edit — one bulk insert, e.g. a paste or
    // execCommand('insertText', ...), matching the reported repro.
    plugin.update(bulkInsertUpdate("eta body"));

    // Confirmed vendored bug: this is swallowed — the LoroText never saw it.
    expect(getText(doc).toString()).toBe("");

    // A second edit after the flag has been consumed does land normally.
    plugin.update(bulkInsertUpdate(" more"));
    expect(getText(doc).toString()).toBe(" more");
  });

  it("fix: a harmless dispatch right after mount consumes the swallow, so the user's real first edit lands", async () => {
    const LoroSyncPluginValue = await loadLoroSyncPluginValue();
    const doc = new LoroDoc();
    const getText = (d: LoroDoc) => d.getText(CONTENT_KEY);
    const view = new FakeView();

    const plugin = new LoroSyncPluginValue(view, doc, getText);

    // Mirrors NoteEditor.tsx's fix: schedule a no-op dispatch right after
    // construction (a later microtask than the plugin's own), which
    // reaches update() and consumes isInitDispatch before any real edit
    // could plausibly arrive (a genuine user keystroke is always a later
    // task, never in the same microtask-draining turn).
    const warmUp = Promise.resolve().then(() => {
      plugin.update({
        docChanged: false,
        transactions: [],
        changes: { iterChanges: () => {} },
      });
    });
    await warmUp;

    plugin.update(bulkInsertUpdate("eta body"));

    expect(getText(doc).toString()).toBe("eta body");
  });
});
