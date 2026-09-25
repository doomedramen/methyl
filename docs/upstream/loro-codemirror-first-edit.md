# Upstream issue draft: loro-codemirror drops the first edit

To file at <https://github.com/loro-dev/loro-codemirror/issues>. Once filed,
put the issue link in `NoteEditor.tsx` (above the warm-up dispatch) and in
`TODO.md`, replacing the pointer to this file.

---

**Title:** `LoroSyncPlugin` drops the first edit when the editor already shows the doc's text

**Version:** loro-codemirror 0.3.3 (loro-crdt 1.x, @codemirror/view 6.x)

**What happens.** Create an `EditorView` whose initial text already equals
the `LoroText`, with `LoroSyncPlugin(doc)`. The first change the user makes
appears in the editor but never reaches the `LoroText`. Later edits sync
normally, so the two stay out of step from then on.

**Why.** In `LoroSyncPluginValue`'s constructor (`dist/sync.js`), the
microtask sets `this.isInitDispatch = true` *before* comparing the texts:

```js
Promise.resolve().then(() => {
  this.isInitDispatch = true;
  const currentText = this.view.state.doc.toString();
  const text = this.getTextFromDoc(this.doc);
  if (currentText === text.toString()) {
    return; // nothing dispatched, but the flag stays set
  }
  view.dispatch({ ... });
});
```

When the texts match, nothing is dispatched, so the flag is never consumed by
the init dispatch. `update()` then swallows the next update, which is the
user's first real edit:

```js
update(update) {
  if (this.isInitDispatch) {
    this.isInitDispatch = false;
    return;
  }
  ...
}
```

**Suggested fix.** Set the flag only when the init dispatch actually
happens:

```js
if (currentText === text.toString()) return;
this.isInitDispatch = true;
view.dispatch({ ... });
```

(or mark the init transaction with `loroSyncAnnotation` and drop the flag).

**Repro.** [`loro-codemirror-first-edit.mjs`](loro-codemirror-first-edit.mjs):
plain Node + jsdom, using only the public `LoroSyncPlugin`. It prints

```text
editor: "hello world"
loro:   "hello"
BUG: the first edit never reached the LoroText.
```

**Workaround we use.** Dispatch an empty transaction right after creating
the view, so the stray flag swallows that instead of a real edit.
