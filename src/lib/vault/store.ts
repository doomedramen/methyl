import type { PersistedDocState, PersistedTreeState } from "@/lib/core/types";

/**
 * Low-level persistence primitives for one document's CRDT state.
 * Implemented identically by Node FS and OPFS; VaultEngine programs against these.
 *
 * Layout (§10):
 *
 *   .adhd/crdt/docs/<docId>/
 *     snapshot.loro
 *     updates/
 *       000001.loro
 *       000002.loro
 *     state.json
 *
 * All CRDT data flows as raw Uint8Array — no encoding.
 * Markdown is the only path where UTF-8 enters via TextEncoder/TextDecoder.
 */
export interface PersistedDocStore {
  /** List persisted doc directories. For recovery/GC, NOT normal vault discovery. */
  listDocumentIds(): Promise<string[]>;

  loadSnapshot(docId: string): Promise<Uint8Array | null>;
  loadUpdates(docId: string): Promise<Uint8Array[]>;

  appendUpdate(docId: string, update: Uint8Array): Promise<void>;

  /**
   * Atomic compaction: write snapshot + state, remove superseded updates.
   * Recovery-safe: in-flight .tmp renames are detected and cleaned on next open.
   */
  compact(
    docId: string,
    snapshot: Uint8Array,
    state: PersistedDocState,
  ): Promise<void>;

  readState(docId: string): Promise<PersistedDocState | null>;

  /** Read a materialised Markdown file (UTF-8 bytes). Returns null if absent. */
  readMaterialized(path: string): Promise<Uint8Array | null>;

  /** Atomically write materialised Markdown via tmp → rename. */
  writeMaterializedAtomic(path: string, bytes: Uint8Array): Promise<void>;
}

/**
 * Same idea for the vault-tree LoroTree, which has no documentId —
 * it IS the single vault-level CRDT.
 *
 * Layout:
 *   .adhd/crdt/vault/
 *     snapshot.loro
 *     updates/
 *     state.json
 */
export interface VaultTreeStore {
  loadSnapshot(): Promise<Uint8Array | null>;
  loadUpdates(): Promise<Uint8Array[]>;
  appendUpdate(update: Uint8Array): Promise<void>;
  compact(snapshot: Uint8Array, state: PersistedTreeState): Promise<void>;
  readState(): Promise<PersistedTreeState | null>;
}