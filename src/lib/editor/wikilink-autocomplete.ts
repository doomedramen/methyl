import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { WikilinkCandidate } from "@/lib/vault/wikilink";

/**
 * `[[` autocomplete for wikilinks. The filtering/ranking and the "which
 * form of the target avoids ambiguity" logic are plain functions so they
 * can be unit tested without a CodeMirror instance; `wikilinkCompletionSource`
 * is the thin CodeMirror adapter.
 */

/** Notes whose name contains `query` (case-insensitive), name matches first. */
export function filterWikilinkCandidates(
  candidates: WikilinkCandidate[],
  query: string,
): WikilinkCandidate[] {
  const q = query.trim().toLowerCase();
  const matches = q ? candidates.filter((c) => c.name.toLowerCase().includes(q)) : candidates;
  return [...matches].sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The `[[...]]` body to insert for `candidate` — the bare name, or
 * `Folder/Name` when another candidate shares the same case-insensitive
 * name (mirrors `buildWikilinkTarget`'s disambiguation rule).
 */
export function wikilinkInsertText(candidate: WikilinkCandidate, allCandidates: WikilinkCandidate[]): string {
  const ambiguous = allCandidates.some(
    (c) => c.documentId !== candidate.documentId && c.name.toLowerCase() === candidate.name.toLowerCase(),
  );
  return ambiguous && candidate.folder ? `${candidate.folder}/${candidate.name}` : candidate.name;
}

/** Match `[[query` immediately before the cursor, with no closing `]]` yet. */
export function matchWikilinkPrefix(
  text: string,
  cursor: number,
): { from: number; query: string } | undefined {
  const upto = text.slice(0, cursor);
  const idx = upto.lastIndexOf("[[");
  if (idx === -1) return undefined;
  const between = upto.slice(idx + 2);
  if (between.includes("]") || between.includes("\n")) return undefined;
  return { from: idx, query: between };
}

export function wikilinkCompletionSource(getCandidates: () => WikilinkCandidate[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const hit = matchWikilinkPrefix(line.text, context.pos - line.from);
    if (!hit && !context.explicit) return null;
    if (!hit) return null;
    const from = line.from + hit.from;

    const candidates = getCandidates();
    const filtered = filterWikilinkCandidates(candidates, hit.query);

    return {
      from,
      to: context.pos,
      options: filtered.map((c) => ({
        label: c.name,
        detail: c.folder || undefined,
        apply: (view, _completion, applyFrom, applyTo) => {
          const insert = `[[${wikilinkInsertText(c, candidates)}]]`;
          view.dispatch({
            changes: { from: applyFrom, to: applyTo, insert },
            selection: { anchor: applyFrom + insert.length },
          });
        },
      })),
      filter: false,
    };
  };
}
