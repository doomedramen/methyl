import { Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightSpecialChars,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
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
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { livePreview, type LivePreviewOptions } from "@/lib/editor/live-preview";
import { wikilinkCompletionSource } from "@/lib/editor/wikilink-autocomplete";
import type { WikilinkCandidate } from "@/lib/vault/wikilink";
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
  /** Wikilink resolution + click/keyboard-open/create wiring (§ wikilinks). */
  wikilinks?: LivePreviewOptions & { getCandidates?: () => WikilinkCandidate[] };
}): Extension {
const { doc, ephemeral, user, undoManager, wikilinks } = opts;
  const getText: (d: LoroDoc) => LoroText = getContentTextFromDoc;

  return [
    highlightSpecialChars(),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    amoledMinimal,
    amoledDark,
    amoledMono,
    syntaxHighlighting(defaultHighlightStyle),
    autocompletion({
      override: wikilinks?.getCandidates
        ? [wikilinkCompletionSource(wikilinks.getCandidates)]
        : undefined,
    }),
    // Accepting a completion (e.g. Enter on an open wikilink popup) must win
    // over markdownKeymap's own Enter (list continuation) below — CodeMirror's
    // autocomplete docs call for Prec.highest on its keymap for this reason.
    Prec.highest(keymap.of(completionKeymap)),
    keymap.of([
      // Markdown-aware Enter/Backspace (continue lists, dedent markup) takes
      // precedence over the generic defaults below.
      ...markdownKeymap,
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
    livePreview(wikilinks),
    // Collaborative binding first so state is authoritative in Loro
    LoroSyncPlugin(doc, getText),
    LoroUndoPlugin(doc, undoManager, getText),
    LoroEphemeralPlugin(doc, ephemeral, user, getText),
  ];
}

export function editorBaseTheme(): Extension[] {
  return [EditorView.lineWrapping, amoledMinimal];
}