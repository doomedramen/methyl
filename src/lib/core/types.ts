import type { OpId } from "loro-crdt";

export type NodeKind = "markdown" | "binary" | "directory";

export interface TreeNodeMeta {
  id: string;
  name: string;
  kind: NodeKind;
  documentId?: string;
  sha256?: string;
}

export interface MaterializationCheckpoint {
  documentId: string;
  frontiers: OpId[];
  sha256: string;
}

export interface DirtyRoom {
  roomId: string;
  targetFrontiers: OpId[];
}

export interface ChangeRecord {
  seq: number;
  objectId: string;
  type: "doc" | "asset" | "tree";
  timestamp: number;
}

export interface ChangeQueryResult {
  reset: boolean;
  changes: ChangeRecord[];
  minRetainedSeq?: number;
}

export interface DocIndexEntry {
  id: string;
  title: string;
  path: string;
  body: string;
  tags: string[];
  aliases: string[];
  headings: string[];
}

export interface ParsedDocument {
  id: string;
  title: string;
  headings: string[];
  wikilinks: string[];
  links: string[];
  tags: string[];
  aliases: string[];
  frontmatter: Record<string, unknown>;
  body: string;
}

export type SyncState =
  | { status: "saved_local"; nWaiting: number }
  | { status: "syncing"; done: number; total: number }
  | { status: "synced" }
  | { status: "error"; message: string };

export const NODE_PATH_SEPARATOR = "/";

/**
 * Compaction bookkeeping + materialisation checkpoint for one document.
 * Persisted as docs/<id>/state.json. Binary CRDT state is never encoded here —
 * fields are Loro OpIds and the Markdown hash plus compaction counters.
 */
export interface PersistedDocState {
  documentId: string;
  /** Loro frontiers of the snapshot (or empty on fresh doc). */
  frontiers: OpId[];
  /** SHA-256 of the materialised Markdown (empty if not materialised). */
  sha256: string;
  compactedAt: number;
  lastUpdateAt: number;
  segments: number;
  updateBytes: number;
}

/** Compaction bookkeeping for the vault-tree CRDT. */
export interface PersistedTreeState {
  frontiers: OpId[];
  compactedAt: number;
  lastUpdateAt: number;
  segments: number;
  updateBytes: number;
}