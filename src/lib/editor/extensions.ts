import { type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightSpecialChars,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  type KeyBinding,
} from "@codemirror/view";
import {
  indentOnInput,
  bracketMatching,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { type LoroDoc, type LoroText, type EphemeralStore, type UndoManager } from "loro-crdt";
import {
  LoroEphemeralPlugin,
  LoroSyncPlugin,
  LoroUndoPlugin,
  undo,
  redo,
} from "loro-codemirror";
import { getContentTextFromDoc, type EditorUser } from "@/lib/editor/sync";
import { amoledMinimal, amoledMono, amoledDark } from "@/lib/editor/theme";

/** Undo/redo through Loro's UndoManager (not CodeMirror's native history). */
const loroUndoKeymap: KeyBinding[] = [
  { key: "Mod-z", run: undo, preventDefault: true },
  { key: "Mod-y", mac: "Mod-Shift-z", run: redo, preventDefault: true },
];

/** Base editor scoped to single-note editing. */
export function adhdEditorExtensions(opts: {
  doc: LoroDoc;
  ephemeral: EphemeralStore;
  user: EditorUser;
  undoManager: UndoManager;
}): Extension {
const { doc, ephemeral, user, undoManager } = opts;
  const getText: (d: LoroDoc) => LoroText = getContentTextFromDoc;

  return [
    highlightSpecialChars(),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    indentOnInput(),
    bracketMatching(),
    amoledMinimal,
    amoledDark,
    amoledMono,
    syntaxHighlighting(defaultHighlightStyle),
    keymap.of([
      // Movement/editing from CM, but not its native undo stack
      ...defaultKeymap.filter(
        (b) => b.key !== "Mod-z" && b.key !== "Mod-y" && b.key !== "Ctrl-z",
      ),
      ...foldKeymap,
      ...loroUndoKeymap,
      indentWithTab,
    ]),
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      addKeymap: false,
    }),
    // Collaborative binding first so state is authoritative in Loro
    LoroSyncPlugin(doc, getText),
    LoroUndoPlugin(doc, undoManager, getText),
    LoroEphemeralPlugin(doc, ephemeral, user, getText),
  ];
}

export function editorBaseTheme(): Extension[] {
  return [EditorView.lineWrapping, amoledMinimal];
}