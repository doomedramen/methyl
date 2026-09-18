import { Compartment, Prec, type Extension } from "@codemirror/state";
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
  /** Owned by the caller (one per mounted EditorView) so plugin extensions
   *  can be swapped live via `reconfigurePluginCompartment` (spec §3). */
  pluginCompartment: Compartment;
}): Extension {
  const { doc, ephemeral, user, undoManager, wikilinks, pluginCompartment } = opts;
  const getText: (d: LoroDoc) => LoroText = getContentTextFromDoc;

  // Temporary scaffolding kept until core-live-preview/core-wikilinks plugins
  // (plan Task 9/10) move this logic into plugins and callers start passing
  // registry.buildExtension() instead.
  const defaultPluginExtension: Extension = [
    autocompletion({
      override: wikilinks?.getCandidates
        ? [wikilinkCompletionSource(wikilinks.getCandidates)]
        : undefined,
    }),
    Prec.highest(keymap.of(completionKeymap)),
    livePreview(wikilinks),
  ];

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
    pluginCompartment.of(defaultPluginExtension),
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
    // Collaborative binding first so state is authoritative in Loro
    LoroSyncPlugin(doc, getText),
    LoroUndoPlugin(doc, undoManager, getText),
    LoroEphemeralPlugin(doc, ephemeral, user, getText),
  ];
}

export function editorBaseTheme(): Extension[] {
  return [EditorView.lineWrapping, amoledMinimal];
}