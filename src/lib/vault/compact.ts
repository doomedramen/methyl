/**
 * Shared atomic compact protocol used by both Node FS and OPFS stores (§10, §11).
 *
 * order:
 *   1. write snapshot.tmp
 *   2. write state.tmp
 *   3. flush both (platform persistence)
 *   4. rename snapshot.tmp  → snapshot.loro
 *   5. rename state.tmp     → state.json
 *   6. remove superseded updates/
 *
 * A crash at any point is recoverable: in-flight .tmp files are invisible to
 * loaders, superseded updates are only removed AFTER both renames commit, so
 * an interrupted compaction at worst leaves the old snapshot + old updates
 * (and a discarded .tmp), which is consistent.
 */
export interface AtomicOps {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  flush?(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string): Promise<void>;
}

const SNAPSHOT = "snapshot.loro";
const STATE = "state.json";
const SNAPSHOT_TMP = "snapshot.loro.tmp";
const STATE_TMP = "state.json.tmp";

export async function atomicCompact(
  ops: AtomicOps,
  dir: string,
  snapshot: Uint8Array,
  stateJson: string,
): Promise<void> {
  await ops.mkdir(dir);
  await ops.writeFile(`${dir}/${SNAPSHOT_TMP}`, snapshot);
  await ops.writeFile(
    `${dir}/${STATE_TMP}`,
    new TextEncoder().encode(stateJson),
  );
  await ops.flush?.(`${dir}/${SNAPSHOT_TMP}`);
  await ops.flush?.(`${dir}/${STATE_TMP}`);
  await ops.rename(`${dir}/${SNAPSHOT_TMP}`, `${dir}/${SNAPSHOT}`);
  await ops.rename(`${dir}/${STATE_TMP}`, `${dir}/${STATE}`);
  await ops.rm(`${dir}/updates`);
}

/** Remove leftover .tmp from an interrupted compact. Loaders always call this. */
export async function cleanupInterrupted(ops: AtomicOps, dir: string): Promise<void> {
  let names: string[];
  try {
    names = await ops.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith(".tmp")) {
      await ops.rm(`${dir}/${name}`);
    }
  }
}

/** Next segment number given current update filenames. */
export function nextSegmentNumber(files: string[]): number {
  let max = 0;
  for (const f of files) {
    const m = /^(\d+)\.loro$/.exec(f);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export function segmentName(seq: number): string {
  return String(seq).padStart(6, "0") + ".loro";
}

export const SEGMENT_RE = /^\d+\.loro$/;

/** Thresholds from §10: 100 segments, 1 MiB of updates, 24 hours. */
export interface CompactionRules {
  maxSegments: number;
  maxBytes: number;
  maxAgeMs: number;
}

export const DEFAULT_COMPACTION_RULES: CompactionRules = {
  maxSegments: 100,
  maxBytes: 1024 * 1024,
  maxAgeMs: 24 * 60 * 60 * 1000,
};

export interface CompactionCounters {
  segments: number;
  updateBytes: number;
  compactedAt: number;
}

export function shouldCompact(
  counters: CompactionCounters,
  now = Date.now(),
  rules: CompactionRules = DEFAULT_COMPACTION_RULES,
): boolean {
  return (
    counters.segments >= rules.maxSegments ||
    counters.updateBytes >= rules.maxBytes ||
    now - counters.compactedAt >= rules.maxAgeMs
  );
}