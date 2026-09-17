import { EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";

/**
 * Minimal reader-style theme with dark support via the `dark` flag.
 * Deliberately restrained — no borders, soft gutters, quiet syntax colors
 * that scale with the note content rather than the UI. Colors are sourced
 * from shadcn design tokens (globals.css) so the editor tracks the active
 * theme (light/dark, and any future palette) automatically.
 */
export const amoledMinimal = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--foreground)",
    fontSize: "clamp(15px, 1rem, 17px)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    caretColor: "var(--primary)",
    padding: "16px max(16px, calc((100% - 760px) / 2)) 40vh",
    maxWidth: "760px",
    lineHeight: "1.7",
    fontFamily: "var(--font-sans, inherit)",
  },
  ".cm-line": {
    padding: "0 0 4px 0",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--muted-foreground)",
    paddingLeft: "8px",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--accent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--accent) 70%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--primary)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--chart-4) 45%, transparent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    border: "none",
    color: "var(--muted-foreground)",
  },
}, { dark: false });

/** Dark-mode overrides; toggled on the containing element via `.dark`. */
const amoledDark = EditorView.theme({
  "&": {
    color: "var(--foreground)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--accent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
  },
}, { dark: true });

/** Mono stack for code blocks. */
export const amoledMono = EditorView.theme({
  ".cm-completionLabel": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
  },
});

export { amoledDark };
