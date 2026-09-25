// Standalone repro for a loro-codemirror bug: the first edit after the
// editor is created is dropped when the editor already shows the doc's text.
// Needs: loro-crdt, loro-codemirror, @codemirror/state, @codemirror/view, jsdom.
//   node loro-codemirror-first-edit.mjs
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
// jsdom lacks layout APIs CodeMirror touches while measuring.
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });

const { LoroDoc } = await import("loro-crdt");
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { LoroSyncPlugin } = await import("loro-codemirror");

const doc = new LoroDoc();
doc.getText("codemirror").insert(0, "hello");
doc.commit();

// The editor starts with the doc's text, as any app restoring a note does.
const view = new EditorView({
  state: EditorState.create({ doc: "hello", extensions: [LoroSyncPlugin(doc)] }),
  parent: document.body,
});

// Let the plugin's constructor microtask run (it sets isInitDispatch = true,
// then returns early because the texts already match, so nothing consumes it).
await Promise.resolve();
await Promise.resolve();

// The user's first edit.
view.dispatch({ changes: { from: 5, insert: " world" } });
doc.commit();

const editor = view.state.doc.toString();
const loro = doc.getText("codemirror").toString();
console.log("editor:", JSON.stringify(editor));
console.log("loro:  ", JSON.stringify(loro));
if (editor !== loro) {
  console.log("BUG: the first edit never reached the LoroText.");
  process.exitCode = 1;
} else {
  console.log("OK: the first edit reached the LoroText.");
}
view.destroy();
