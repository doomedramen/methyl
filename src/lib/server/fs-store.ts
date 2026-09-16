import { promises as fs } from "fs";
import { join, dirname } from "path";
import type { PersistedDocStore, VaultTreeStore } from "@/lib/vault/store";
import type { PersistedDocState, PersistedTreeState } from "@/lib/core/types";
import {
  atomicCompact,
  cleanupInterrupted,
  nextSegmentNumber,
  segmentName,
  SEGMENT_RE,
  type AtomicOps,
} from "@/lib/vault/compact";

/**
 * Node filesystem-backed stores (§10, §11). Used by the server (/vault) and
 * in recovery tests. Writes are crash-safe: data file → tmp → fsync → rename.
 *
 * Layout:
 *   .adhd/crdt/docs/<docId>/   snapshot.loro + updates/ + state.json
 *   .adhd/crdt/vault/          snapshot.loro + updates/ + state.json
 */
class NodePersistBackend {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async loadSnapshot(dir: string): Promise<Uint8Array | null> {
    await cleanupInterrupted(ops, dir);
    const file = join(dir, "snapshot.loro");
    try {
      return new Uint8Array(await fs.readFile(file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async loadUpdates(dir: string): Promise<Uint8Array[]> {
    await cleanupInterrupted(ops, dir);
    const updatesDir = join(dir, "updates");
    let files: string[];
    try {
      files = (await fs.readdir(updatesDir))
        .filter((f) => SEGMENT_RE.test(f))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Uint8Array[] = [];
    for (const f of files) {
      out.push(await fs.readFile(join(updatesDir, f)).then((b) => new Uint8Array(b)));
    }
    return out;
  }

  async appendUpdate(dir: string, update: Uint8Array): Promise<void> {
    await this.ensureDir(join(dir, "updates"));
    let files: string[];
    try {
      files = (await fs.readdir(join(dir, "updates"))).filter((f) =>
        SEGMENT_RE.test(f),
      );
    } catch {
      files = [];
    }
    const next = nextSegmentNumber(files);
    await fs.writeFile(
      join(dir, "updates", segmentName(next)),
      update,
    );
    await this.bumpState(dir, 1, update.length);
  }

  /** Bump compaction counters in state.json after an append (§10). */
  private async bumpState(dir: string, segments: number, bytes: number): Promise<void> {
    const state = await this.readStateJson<
      { segments: number; updateBytes: number; lastUpdateAt?: number }
      & Record<string, unknown>
    >(dir);
    if (!state) return;
    const now = Date.now();
    const nextState = {
      ...state,
      segments: (state.segments ?? 0) + segments,
      updateBytes: (state.updateBytes ?? 0) + bytes,
      lastUpdateAt: now,
    };
    await fs.writeFile(join(dir, "state.json"), JSON.stringify(nextState, null, 2));
  }

  async compact(
    dir: string,
    snapshot: Uint8Array,
    stateJson: string,
  ): Promise<void> {
    await this.ensureDir(dir);
    await atomicCompact(ops, dir, snapshot, stateJson);
  }

  async readStateJson<T>(dir: string): Promise<T | null> {
    await cleanupInterrupted(ops, dir);
    const file = join(dir, "state.json");
    try {
      const raw = await fs.readFile(file, "utf-8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async listDocDirs(): Promise<string[]> {
    const docsDir = join(this.root, ".adhd/crdt/docs");
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(docsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return entries
      .filter((e) => e.isDirectory() && /^[0-9a-fA-F-]{8,36}$/.test(e.name))
      .map((e) => e.name);
  }

  async readMaterialized(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(join(this.root, path)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeMaterializedAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const full = join(this.root, path);
    await this.ensureDir(dirname(full));
    await fs.writeFile(full + ".tmp", bytes);
    await fs.rename(full + ".tmp", full);
  }
}

const ops: AtomicOps = {
  writeFile: async (p, d) => {
    await fs.writeFile(p, d);
  },
  flush: async (p) => {
    const h = await fs.open(p, "r+");
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  },
  rename: async (from, to) => {
    await fs.rename(from, to);
  },
  mkdir: async (p) => {
    await fs.mkdir(p, { recursive: true });
  },
  readdir: async (p) => {
    try {
      return await fs.readdir(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  },
  rm: async (p) => {
    await fs.rm(p, { recursive: true, force: true });
  },
};

export class NodeFSStore implements PersistedDocStore {
  private backend: NodePersistBackend;

  constructor(root: string) {
    this.backend = new NodePersistBackend(root);
  }

  private dir(docId: string): string {
    return join(this.backend.root, ".adhd/crdt/docs", docId);
  }

  listDocumentIds(): Promise<string[]> {
    return this.backend.listDocDirs();
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

  async compact(
    docId: string,
    snapshot: Uint8Array,
    state: PersistedDocState,
  ): Promise<void> {
    await this.backend.compact(this.dir(docId), snapshot, JSON.stringify(state));
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
}

export class NodeVaultTreeStore implements VaultTreeStore {
  private backend: NodePersistBackend;

  constructor(root: string) {
    this.backend = new NodePersistBackend(root);
  }

  private dir(): string {
    return join(this.backend.root, ".adhd/crdt/vault");
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

  async compact(snapshot: Uint8Array, state: PersistedTreeState): Promise<void> {
    await this.backend.compact(this.dir(), snapshot, JSON.stringify(state));
  }

  readState(): Promise<PersistedTreeState | null> {
    return this.backend.readStateJson<PersistedTreeState>(this.dir());
  }
}