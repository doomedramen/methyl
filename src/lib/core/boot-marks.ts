/**
 * Startup timing (spec item 20). Each phase of opening the app records a
 * `performance.mark("methyl:<phase>")`, so a real device's startup can be
 * read from the diagnostics or the browser's performance timeline, and a
 * test can assert on it. Safe to call on the server, where it's a no-op
 * unless `performance` exists.
 */
export type BootPhase =
  | "boot-start"
  | "modules-loaded"
  | "lock-acquired"
  | "tree-loaded"
  | "documents-loaded"
  | "indexes-ready"
  | "vault-opened"
  | "reconciled"
  | "engine-ready";

const PREFIX = "methyl:";

export function markBoot(phase: BootPhase): void {
  try {
    globalThis.performance?.mark?.(`${PREFIX}${phase}`);
  } catch {
    // Marks are diagnostics only.
  }
}

/** Milliseconds since navigation start for each recorded phase, in order. */
export function bootTimings(): Array<{ phase: string; ms: number }> {
  const entries = globalThis.performance?.getEntriesByType?.("mark") ?? [];
  return entries
    .filter((entry) => entry.name.startsWith(PREFIX))
    .map((entry) => ({ phase: entry.name.slice(PREFIX.length), ms: Math.round(entry.startTime) }));
}
