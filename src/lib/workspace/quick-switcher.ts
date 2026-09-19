export interface QuickSwitcherEntry {
  id: string;
  title: string;
  path: string;
  isGraph?: boolean;
}

export interface RankedQuickSwitcherEntry extends QuickSwitcherEntry {
  score: number;
}

function subsequenceScore(value: string, query: string): number | null {
  if (!query) return 0;
  let cursor = 0;
  let gaps = 0;
  for (const character of query) {
    const index = value.indexOf(character, cursor);
    if (index < 0) return null;
    gaps += index - cursor;
    cursor = index + 1;
  }
  return Math.max(0, 100 - gaps - Math.max(0, value.length - query.length) * 0.1);
}

function scoreEntry(entry: QuickSwitcherEntry, query: string): number | null {
  if (!query) return 0;
  const title = entry.title.toLowerCase();
  const path = entry.path.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 0;
  const titleExact = title === normalizedQuery;
  const titlePrefix = title.startsWith(normalizedQuery);
  const pathPrefix = path.startsWith(normalizedQuery);
  const titleScore = subsequenceScore(title, normalizedQuery);
  const pathScore = subsequenceScore(path, normalizedQuery);
  if (titleScore === null && pathScore === null) return null;
  return (
    (titleExact ? 1_000 : 0) +
    (titlePrefix ? 500 : 0) +
    (pathPrefix ? 250 : 0) +
    Math.max(titleScore ?? 0, (pathScore ?? 0) * 0.8)
  );
}

export function rankQuickSwitcher(
  entries: QuickSwitcherEntry[],
  query: string,
  recentDocumentIds: string[] = [],
  limit = 50,
): RankedQuickSwitcherEntry[] {
  const recent = new Map(recentDocumentIds.map((id, index) => [id, index]));
  return entries
    .map((entry, index) => {
      const score = scoreEntry(entry, query);
      if (score === null) return null;
      const recentIndex = recent.get(entry.id);
      return {
        ...entry,
        score: score + (recentIndex === undefined ? 0 : Math.max(0, 100 - recentIndex)),
        recentIndex: recentIndex ?? Number.MAX_SAFE_INTEGER,
        index,
      };
    })
    .filter((entry): entry is RankedQuickSwitcherEntry & { recentIndex: number; index: number } => entry !== null)
    .sort((a, b) => b.score - a.score || a.recentIndex - b.recentIndex || a.index - b.index)
    .slice(0, limit)
    .map(({ id, title, path, isGraph, score }) => ({ id, title, path, isGraph, score }));
}
