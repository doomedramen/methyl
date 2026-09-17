import type { PersistedDocStore } from "@/lib/vault/store";

/**
 * Ring-buffer diagnostics log for destructive vault operations (§5 of the
 * safety-rail plan). Earlier in development a browser vault lost its whole
 * tree and all CRDT files under `.adhd/crdt`; the cause was never
 * confirmed. Rather than guess again, every deletion, sweep, and safety-rail
 * refusal is recorded here so a future unexplained wipe leaves evidence.
 *
 * Persisted at the vault-local, never-synced `.adhd/vault-meta/` area (same
 * spot as seed-marker.ts) via `PersistedDocStore.writeMaterializedAtomic` /
 * `readMaterialized` directly — like `VaultEngine`'s own `DOC_INDEX_PATH`,
 * this is a deliberate, narrow exception to the "materialised paths never
 * touch .adhd/" guard, not a bypass of it.
 *
 * Every entry is timestamp + operation name + small numeric counts + short
 * detail strings (ids, paths, counts) — never note content.
 *
 * All read/write here is best-effort: a failure must never throw into the
 * caller or block the underlying vault operation, and must never cost the
 * hot path an extra full-store scan.
 */

const DIAGNOSTICS_PATH = ".adhd/vault-meta/diagnostics.json";
const MAX_ENTRIES = 100;

export interface DiagnosticEntry {
  ts: number;
  op: string;
  counts?: Record<string, number>;
  detail?: string;
}

function formatLine(op: string, counts?: Record<string, number>, detail?: string): string {
  const parts = [`[VaultEngine diagnostics] ${op}`];
  if (counts && Object.keys(counts).length > 0) {
    parts.push(JSON.stringify(counts));
  }
  if (detail) parts.push(detail);
  return parts.join(" ");
}

/**
 * Append one entry to the ring buffer and log it via console.warn for live
 * debugging. Never throws — a read/parse/write failure is swallowed after
 * logging, so a diagnostics problem can never break the destructive
 * operation it's trying to record.
 */
export async function recordDiagnostic(
  docStore: PersistedDocStore,
  op: string,
  options?: { counts?: Record<string, number>; detail?: string },
): Promise<void> {
  const counts = options?.counts;
  const detail = options?.detail;
  console.warn(formatLine(op, counts, detail));

  try {
    const entries = await readDiagnostics(docStore);
    entries.push({ ts: Date.now(), op, counts, detail });
    while (entries.length > MAX_ENTRIES) entries.shift();
    await docStore.writeMaterializedAtomic(
      DIAGNOSTICS_PATH,
      new TextEncoder().encode(JSON.stringify(entries)),
    );
  } catch (err) {
    console.warn("[VaultEngine diagnostics] failed to persist diagnostics entry", err);
  }
}

/** Read the ring buffer as-is (oldest first). Returns [] on any failure. */
export async function readDiagnostics(docStore: PersistedDocStore): Promise<DiagnosticEntry[]> {
  try {
    const bytes = await docStore.readMaterialized(DIAGNOSTICS_PATH);
    if (!bytes) return [];
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed)) return [];
    return parsed as DiagnosticEntry[];
  } catch {
    return [];
  }
}
