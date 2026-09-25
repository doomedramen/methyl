import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Smart paste (spec item 18):
 *  - a URL pasted over a selection becomes `[selection](url)`;
 *  - rich HTML (from a web page or a word processor) becomes Markdown;
 *  - Shift (Cmd/Ctrl+Shift+V) pastes the plain text as it is.
 * Files are left to the editor's attachment handling.
 */

const URL_PATTERN = /^https?:\/\/[^\s<>"']+$/i;
/** Tags worth converting; HTML that is only spans and divs pastes as its text. */
const RICH_HTML = /<(a|b|strong|i|em|h[1-6]|ul|ol|li|table|pre|code|blockquote|img|hr)\b/i;

export type PastePlan =
  | { kind: "default" }
  | { kind: "link"; insert: string }
  | { kind: "html"; html: string };

/** Decide what a paste should do; pure, so it can be unit-tested. */
export function planPaste(input: { text: string; html: string; selection: string; plain: boolean }): PastePlan {
  if (input.plain) return { kind: "default" };
  const url = input.text.trim();
  if (input.selection && URL_PATTERN.test(url) && !URL_PATTERN.test(input.selection.trim())) {
    const label = input.selection.replaceAll("[", "\\[").replaceAll("]", "\\]");
    return { kind: "link", insert: `[${label}](${url})` };
  }
  if (input.html && RICH_HTML.test(input.html)) return { kind: "html", html: input.html };
  return { kind: "default" };
}

export function smartPaste(): Extension {
  // Cmd/Ctrl+Shift+V: remembered from the keydown that starts the paste.
  let shiftPaste = false;
  return EditorView.domEventHandlers({
    keydown(event) {
      shiftPaste = event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v";
      return false;
    },
    paste(event, view) {
      const plain = shiftPaste;
      shiftPaste = false;
      const data = event.clipboardData;
      if (event.defaultPrevented || !data || data.files.length > 0) return false;
      const { from, to } = view.state.selection.main;
      const plan = planPaste({
        text: data.getData("text/plain"),
        html: data.getData("text/html"),
        selection: view.state.sliceDoc(from, to),
        plain,
      });
      if (plan.kind === "default") return false;
      event.preventDefault();
      const insertAt = (insert: string) => {
        const end = view.state.doc.length;
        const a = Math.min(from, end);
        const b = Math.min(to, end);
        view.dispatch({
          changes: { from: a, to: b, insert },
          selection: { anchor: a + insert.length },
          userEvent: "input.paste",
          scrollIntoView: true,
        });
      };
      if (plan.kind === "link") {
        insertAt(plan.insert);
        return true;
      }
      const fallback = data.getData("text/plain");
      void import("@/lib/editor/html-to-markdown")
        .then(({ htmlToMarkdown }) => insertAt(htmlToMarkdown(plan.html) || fallback))
        .catch(() => insertAt(fallback));
      return true;
    },
  });
}
