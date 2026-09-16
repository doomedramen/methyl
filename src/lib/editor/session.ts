import { type LoroDoc, type LoroText } from "loro-crdt";
import type { VaultEngine } from "@/lib/vault/engine";
import { acquireVaultWriterLock } from "@/lib/vault/web-locks";
import { getContentTextFromDoc } from "@/lib/editor/sync";

export interface EditorSessionOptions {
  engine: VaultEngine;
  documentId: string;
  /** Debounce for writing local edits to the store. */
  persistDebounceMs?: number;
  /** Force a flush once the doc has been dirty for this long. */
  maxDirtyMs?: number;
  /** Called after a successful incremental persist. */
  onPersisted?: () => void;
}

export interface EditorSession {
  readonly documentId: string;
  readonly doc: LoroDoc;
  readonly text: LoroText;

  /** Mark dirty and schedule a (debounced) incremental persist. */
  schedulePersist(): void;
  /** Immediately write any pending local edits. */
  flush(): Promise<void>;
  isDirty(): boolean;
  lastPersistedAt(): number | null;
  dispose(flush?: boolean): Promise<void>;
}

/**
 * One note open in an editor. Owns the doc↔engine persistence bridge: every
 * local (or remote) change schedules a debounced incremental write, and the
 * UI stays authoritative in the CRDT — never in the CodeMirror state.
 *
 * DOM-free so it is unit-testable; the CodeMirror View is layered on top by
 * the React host.
 */
export function createEditorSession(opts: EditorSessionOptions): EditorSession {
  const {
    engine,
    documentId,
    persistDebounceMs = 400,
    maxDirtyMs = 2_000,
    onPersisted,
  } = opts;

  const handle = engine.getDocument(documentId);
  if (!handle) throw new Error(`Document not open in engine: ${documentId}`);
  const doc = handle.doc;
  const text = getContentTextFromDoc(doc);

  let dirty = false;
  let lastPersisted: number | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxAgeTimer: ReturnType<typeof setTimeout> | null = null;
  let processing = false;
  let disposed = false;

  const clearTimers = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxAgeTimer) clearTimeout(maxAgeTimer);
    debounceTimer = null;
    maxAgeTimer = null;
  };

  const beginTimers = () => {
    clearTimers();
    debounceTimer = setTimeout(() => void flush(), persistDebounceMs);
    maxAgeTimer = setTimeout(() => {
      if (dirty) void flush();
    }, maxDirtyMs);
  };

  const flush = async (): Promise<void> => {
    clearTimers();
    if (disposed) return;
    if (!dirty) return;
    processing = true;
    try {
      const lock = await acquireVaultWriterLock(engine.vaultId);
      await lock.guard(() => engine.persistDocumentIncremental(documentId));
      lastPersisted = Date.now();
      dirty = false;
      onPersisted?.();
    } finally {
      processing = false;
      // Edits that landed while persisting must flush again
      if (dirty && !disposed && !debounceTimer) beginTimers();
    }
  };

  const unsubLocal = doc.subscribeLocalUpdates(() => {
    if (disposed) return;
    dirty = true;
    if (!processing) beginTimers();
  });

  const unsubscribe = () => {
    if (disposed) return;
    disposed = true;
    clearTimers();
    unsubLocal();
  };

  return {
    documentId,
    doc,
    text,
    schedulePersist: () => {
      dirty = true;
      beginTimers();
    },
    flush,
    isDirty: () => dirty,
    lastPersistedAt: () => lastPersisted,
    dispose: async (flushFirst = true) => {
      if (flushFirst) await flush();
      unsubscribe();
    },
  };
}