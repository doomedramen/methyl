import { EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";

/**
 * Minimal reader-style theme with dark support via the `dark` flag.
 * Deliberately restrained — no borders, soft gutters, quiet syntax colors
 * that scale with the note content rather than the UI.
 */
export const amoledMinimal = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--cm-fg, var(--color-cm-fg, #222))",
    fontSize: "15px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    caretColor: "var(--cm-caret, #3b82f6)",
    padding: "24px 32px 40vh",
    maxWidth: "760px",
    lineHeight: "1.65",
    fontFamily: "var(--cm-font, inherit)",
  },
  ".cm-line": {
    padding: "0 0 4px 0",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--cm-gutter, #a1a1aa)",
    paddingLeft: "8px",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--cm-active-line, rgba(0,0,0,0.025))",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "var(--cm-selection, rgba(59,130,246,0.18))",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--cm-caret, #3b82f6)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--cm-search-match, rgba(250,204,21,0.35))",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--cm-fold, rgba(0,0,0,0.05))",
    border: "none",
    color: "var(--cm-gutter, #a1a1aa)",
  },
  "&dark": {
    "&": {
      color: "#e4e4e7",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255,255,255,0.04)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "rgba(255,255,255,0.08)",
    },
  },
}, { dark: false });

/** Mono stack for code blocks. */
export const amoledMono = EditorView.theme({
  ".cm-completionLabel": {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  },
});

export type { Extension };