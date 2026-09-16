/**
 * Durable-sync primitives (SPEC §19/§20/§34).
 *
 * The server ACK only proves "accepted"; "durably synced" additionally
 * requires the server's persisted VersionVector to dominate the target
 * version of every locally applied update (§20). Loro VersionVectors are
 * structurally `Record<peer, counter>`, so these helpers stay dependency-
 * free and avoid pulling CRDT/WASM into the test graph.
 */

export type VersionVector = Record<string, number>;

export interface DirtyEntry {
  roomId: string;
  /** Local version that must become durable before the room is clean. */
  targetVersion: VersionVector;
  updatedAt: number;
}

const LT = -1;
const EQ = 0;
const GT = 1;

/** Compare two VersionVectors in Loro's partial order. */
export function compareVersions(a: VersionVector, b: VersionVector): -1 | 0 | 1 {
  let out: -1 | 0 | 1 = EQ;
  const peers = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const peer of peers) {
    const ac = a[peer] ?? 0;
    const bc = b[peer] ?? 0;
    if (ac === bc) continue;
    const c = ac > bc ? GT : LT;
    if (out === EQ) {
      out = c;
    } else if (out !== c) {
      // Incomparable (concurrent).
      return 0;
    }
  }
  return out;
}

/** `a` is at or ahead of `b` on every peer present in `b`. */
export function coversVersion(a: VersionVector, b: VersionVector): boolean {
  for (const peer of Object.keys(b)) {
    if ((a[peer] ?? 0) < b[peer]) return false;
  }
  return true;
}

/** Merge two vectors (per-peer max). */
export function mergeVersions(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...b };
  for (const [peer, counter] of Object.entries(a)) {
    out[peer] = Math.max(out[peer] ?? 0, counter);
  }
  return out;
}

/**
 * Records rooms whose local updates have not yet been durably confirmed
 * by the server. A room is cleared only when
 * `serverDurableVersion covers localTargetVersion`.
 */
export class DirtyJournal {
  private readonly entries = new Map<string, DirtyEntry>();
  /** Monotonically scoped server sequence marker (see lastServerSeq). */
  private lastServerSeq = 0;

  constructor(initial: DirtyEntry[] = [], lastServerSeq = 0) {
    for (const e of initial) this.entries.set(e.roomId, e);
    this.lastServerSeq = lastServerSeq;
  }

  /** Record a local change that now needs durable confirmation. */
  markDirty(roomId: string, targetVersion: VersionVector, now = Date.now()): void {
    const prev = this.entries.get(roomId);
    this.entries.set(roomId, {
      roomId,
      targetVersion: prev ? mergeVersions(prev.targetVersion, targetVersion) : targetVersion,
      updatedAt: now,
    });
  }

  /**
   * Drop the dirty entry only when the server's durable version has
   * reached the local target version (§20).
   *
   * @returns true when the entry was cleared.
   */
  confirmDurable(roomId: string, serverDurable: VersionVector): boolean {
    const entry = this.entries.get(roomId);
    if (!entry) return false;
    if (!coversVersion(serverDurable, entry.targetVersion)) return false;
    this.entries.delete(roomId);
    return true;
  }

  /** Rooms that still await durable confirmation, ascending by age. */
  dirty(): DirtyEntry[] {
    return [...this.entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  }

  get(roomId: string): DirtyEntry | undefined {
    return this.entries.get(roomId);
  }

  get size(): number {
    return this.entries.size;
  }

  setServerSeq(seq: number): void {
    this.lastServerSeq = Math.max(this.lastServerSeq, seq);
  }

  getLastServerSeq(): number {
    return this.lastServerSeq;
  }

  snapshot(): { entries: DirtyEntry[]; lastServerSeq: number } {
    return {
      entries: this.dirty(),
      lastServerSeq: this.lastServerSeq,
    };
  }
}

export interface DiscoveryInput {
  /** Local rooms with unconfirmed durable versions. */
  localDirty: string[];
  /** server rows from GET /api/changes?after=<last_server_seq>. */
  serverChanged: string[];
  /** All document IDs present after the merged vault tree (§19 step 5/6). */
  treeDocumentIds: string[];
  /** IDs already known synced; excluded to avoid re-syncing every reconnect. */
  knownSynced: ReadonlySet<string>;
  /** Binary asset IDs known to be missing locally. */
  missingBinaries?: string[];
  /** Hard cap applied to the returned set (for bounded concurrency). */
  max?: number;
}

/**
 * Builds the reconnect work set:
 *
 *   local dirty UNION server changed UNION new tree IDs UNION missing binary IDs
 *
 * Binary IDs are not document rooms; return `{ documents, binaries }`.
 * Results are deterministic (sorted) for testability.
 */
export function buildWorkSet(input: DiscoveryInput): {
  documents: string[];
  binaries: string[];
} {
  const docs = new Set<string>();
  for (const id of input.localDirty) docs.add(id);
  for (const id of input.serverChanged) docs.add(id);
  for (const id of input.treeDocumentIds) {
    if (!input.knownSynced.has(id)) docs.add(id);
  }
  const documents = [...docs].sort();
  const binaries = (input.missingBinaries ?? [])
    .filter((id) => !docs.has(id))
    .sort();
  if (input.max !== undefined) {
    return {
      documents: documents.slice(0, input.max),
      binaries: binaries.slice(0, Math.max(0, input.max - documents.length)),
    };
  }
  return { documents, binaries };
}