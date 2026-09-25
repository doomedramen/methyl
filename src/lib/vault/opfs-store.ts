import { META_DIR, isMetaDirName } from "@/lib/core/paths";
import type { PersistedDocStore, VaultTreeStore } from "@/lib/vault/store";
import type { PersistedDocState, PersistedTreeState } from "@/lib/core/types";
import type { VaultFileSystem } from "@/lib/vault/fs";
import {
  atomicCompact,
  cleanupInterrupted,
  nextSegmentNumber,
  segmentName,
  SEGMENT_RE,
  type AtomicOps,
} from "@/lib/vault/compact";

/**
 * OPFS-backed implementation of PersistedDocStore + VaultTreeStore (§9, §10).
 *
 * Mirrors the exact same layout as the Node stores so the persistence model is
 * portable and §10 recovery logic applies identically.
 */
class OpfsPersistBackend {
  private fs: VaultFileSystem;
  /**
   * One operation at a time per CRDT directory, as the Node store does.
   * Without it, a compaction could delete `updates/` after another persist
   * of the same document had appended a segment the compaction's snapshot
   * didn't include — losing that edit — and a loader's temp-file cleanup
   * could delete a compaction's in-flight `.tmp` files.
   */
  private locks = new Map<string, Promise<void>>();
  /** Directories whose leftover `.tmp` files were already cleaned this session. */
  private cleaned = new Set<string>();

  constructor(fs: VaultFileSystem) {
    this.fs = fs;
  }

  private withLock<T>(dir: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(dir) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.locks.set(
      dir,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  /**
   * Remove `.tmp` files an interrupted compaction left behind. Only a
   * previous session can have left them (this one's compactions hold the
   * lock), so each directory is checked once.
   */
  private async cleanupOnce(dir: string): Promise<void> {
    if (this.cleaned.has(dir)) return;
    await cleanupInterrupted(this.ops(), dir);
    this.cleaned.add(dir);
  }

  loadSnapshot(dir: string): Promise<Uint8Array | null> {
    return this.withLock(dir, async () => {
      await this.cleanupOnce(dir);
      return this.fs.readFile(`${dir}/snapshot.loro`);
    });
  }

  loadUpdates(dir: string): Promise<Uint8Array[]> {
    return this.withLock(dir, () => this.loadUpdatesUnlocked(dir));
  }

  private async loadUpdatesUnlocked(dir: string): Promise<Uint8Array[]> {
    await this.cleanupOnce(dir);
    const updatesDir = `${dir}/updates`;
    const { files } = await this.fs.readdir(updatesDir);
    const sorted = files.filter((f) => SEGMENT_RE.test(f)).sort();
    const out: Uint8Array[] = [];
    for (const f of sorted) {
      const bytes = await this.fs.readFile(`${updatesDir}/${f}`);
      if (bytes) out.push(bytes);
    }
    return out;
  }

  appendUpdate(dir: string, update: Uint8Array): Promise<void> {
    return this.withLock(dir, async () => {
      const updatesDir = `${dir}/updates`;
      await this.fs.mkdir(updatesDir);
      const { files } = await this.fs.readdir(updatesDir);
      const sorted = files.filter((f) => SEGMENT_RE.test(f));
      const next = nextSegmentNumber(sorted);
      await this.fs.writeFile(`${updatesDir}/${segmentName(next)}`, update);
      await this.bumpState(dir, 1, update.length);
    });
  }

  /** Bump compaction counters in state.json after an append (§10). */
  private async bumpState(
    dir: string,
    segments: number,
    bytes: number,
  ): Promise<void> {
    const state = await this.readStateJsonUnlocked<
      { segments: number; updateBytes: number; lastUpdateAt?: number }
      & Record<string, unknown>
    >(dir);
    if (!state) return;
    await this.fs.writeTextAtomic(
      `${dir}/state.json`,
      JSON.stringify({
        ...state,
        segments: (state.segments ?? 0) + segments,
        updateBytes: (state.updateBytes ?? 0) + bytes,
        lastUpdateAt: Date.now(),
      }),
    );
  }

  compact(dir: string, snapshot: Uint8Array, stateJson: string): Promise<void> {
    return this.withLock(dir, async () => {
      await this.fs.mkdir(dir);
      await atomicCompact(this.ops(), dir, snapshot, stateJson);
    });
  }

  readStateJson<T>(dir: string): Promise<T | null> {
    return this.withLock(dir, () => this.readStateJsonUnlocked<T>(dir));
  }

  private async readStateJsonUnlocked<T>(dir: string): Promise<T | null> {
    await this.cleanupOnce(dir);
    const raw = await this.fs.readTextFile(`${dir}/state.json`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async listSubdirs(crdtDir: string, pattern: RegExp): Promise<string[]> {
    const { dirs } = await this.fs.readdir(crdtDir);
    return dirs.filter((d) => pattern.test(d));
  }

  async readMaterialized(path: string): Promise<Uint8Array | null> {
    return this.fs.readFile(path);
  }

  async listMaterializedPaths(): Promise<string[]> {
    const out: string[] = [];
    for await (const { path } of this.fs.walk()) out.push(path);
    return out;
  }

  async listMaterializedDirectories(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      const { dirs } = await this.fs.readdir(dir);
      for (const name of dirs) {
        if (rel === "" && isMetaDirName(name)) continue;
        const path = rel ? `${rel}/${name}` : name;
        out.push(path);
        await walk(path, path);
      }
    };
    await walk("", "");
    return out;
  }

  async removeMaterialized(path: string): Promise<void> {
    await this.fs.delete(path);
    // Directories are implicit in OPFS's own tree; no explicit pruning is
    // needed (an empty FileSystemDirectoryHandle just sits there unused).
  }

  async writeMaterializedAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const tmp = `${path}.tmp`;
    await this.fs.writeFile(tmp, bytes);
    // OPFS rename is not exposed; write directly, close handles, then write real name.
    // OPFS write + close IS the flush guarantee. For atomic: write tmp, delete real, rename.
    // Since OPFS lacks rename, we write real name directly (which is equivalent to rename
    // on OPFS because the last writer wins). The critical guarantee — flush — is ensured
    // by access handle close.
    await this.fs.writeFile(path, bytes);
    await this.fs.delete(tmp);
  }

  private ops(): AtomicOps {
    const fs = this.fs;
    return {
      writeFile: async (p, d) => fs.writeFile(p, d),
      flush: async () => {
        // OPFS access handles flush on close; writeFile above closes the handle.
      },
      rename: async (from, to) => {
        // OPFS has no rename; write to target and clean source.
        // For our compact protocol, this is safe: both snapshot.loro and state.json
        // are written atomically via tmp, then the source tmp is removed.
        const bytes = await fs.readFile(from);
        if (bytes) await fs.writeFile(to, bytes);
        await fs.delete(from);
      },
      mkdir: async (p) => fs.mkdir(p),
      readdir: async (p) => {
        const { files, dirs } = await fs.readdir(p);
        return [...dirs, ...files];
      },
      // Compaction removes the superseded `updates/` directory as a whole.
      rm: async (p) => fs.delete(p, { recursive: p.endsWith("/updates") }),
    };
  }
}

export class OpfsDocStore implements PersistedDocStore {
  private backend: OpfsPersistBackend;
  private root: string;

  constructor(fs: VaultFileSystem, root = `${META_DIR}/crdt/docs`) {
    this.backend = new OpfsPersistBackend(fs);
    this.root = root;
  }

  private dir(docId: string): string {
    return `${this.root}/${docId}`;
  }

  async listDocumentIds(): Promise<string[]> {
    return this.backend.listSubdirs(
      this.root,
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    );
  }

  loadSnapshot(docId: string): Promise<Uint8Array | null> {
    return this.backend.loadSnapshot(this.dir(docId));
  }

  loadUpdates(docId: string): Promise<Uint8Array[]> {
    return this.backend.loadUpdates(this.dir(docId));
  }

  appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    return this.backend.appendUpdate(this.dir(docId), update);
  }

  compact(docId: string, snapshot: Uint8Array, state: PersistedDocState): Promise<void> {
    return this.backend.compact(this.dir(docId), snapshot, JSON.stringify(state));
  }

  readState(docId: string): Promise<PersistedDocState | null> {
    return this.backend.readStateJson<PersistedDocState>(this.dir(docId));
  }

  readMaterialized(path: string): Promise<Uint8Array | null> {
    return this.backend.readMaterialized(path);
  }

  writeMaterializedAtomic(path: string, bytes: Uint8Array): Promise<void> {
    return this.backend.writeMaterializedAtomic(path, bytes);
  }

  listMaterializedPaths(): Promise<string[]> {
    return this.backend.listMaterializedPaths();
  }

  listMaterializedDirectories(): Promise<string[]> {
    return this.backend.listMaterializedDirectories();
  }

  removeMaterialized(path: string): Promise<void> {
    return this.backend.removeMaterialized(path);
  }
}

export class OpfsVaultTreeStore implements VaultTreeStore {
  private backend: OpfsPersistBackend;

  constructor(fs: VaultFileSystem) {
    this.backend = new OpfsPersistBackend(fs);
  }

  private dir(): string {
    return `${META_DIR}/crdt/vault`;
  }

  loadSnapshot(): Promise<Uint8Array | null> {
    return this.backend.loadSnapshot(this.dir());
  }

  loadUpdates(): Promise<Uint8Array[]> {
    return this.backend.loadUpdates(this.dir());
  }

  appendUpdate(update: Uint8Array): Promise<void> {
    return this.backend.appendUpdate(this.dir(), update);
  }

  compact(snapshot: Uint8Array, state: PersistedTreeState): Promise<void> {
    return this.backend.compact(this.dir(), snapshot, JSON.stringify(state));
  }

  readState(): Promise<PersistedTreeState | null> {
    return this.backend.readStateJson<PersistedTreeState>(this.dir());
  }
}
