import { META_DIR, isMetaDirName } from "@/lib/core/paths";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import type { PersistedDocStore, VaultTreeStore } from "@/lib/vault/store";
import type { PersistedDocState, PersistedTreeState } from "@/lib/core/types";
import { assertDeletable, normalizeFilePath } from "@/lib/vault/fs";
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
 *   .methyl/crdt/docs/<docId>/   snapshot.loro + updates/ + state.json
 *   .methyl/crdt/vault/          snapshot.loro + updates/ + state.json
 */
class NodePersistBackend {
  readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = root;
  }

  private async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  private withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.locks.set(key, current.then(() => undefined, () => undefined));
    return current;
  }

  async loadSnapshot(dir: string): Promise<Uint8Array | null> {
    return this.withLock(dir, async () => {
      await cleanupInterrupted(ops, dir);
      const file = join(dir, "snapshot.loro");
      try {
        return new Uint8Array(await fs.readFile(file));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    });
  }

  async loadUpdates(dir: string): Promise<Uint8Array[]> {
    return this.withLock(dir, async () => {
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
    });
  }

  async appendUpdate(dir: string, update: Uint8Array): Promise<void> {
    await this.withLock(dir, async () => {
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
    });
  }

  /** Bump compaction counters in state.json after an append (§10). */
  private async bumpState(dir: string, segments: number, bytes: number): Promise<void> {
    const state = await this.readStateJsonUnlocked<
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
    await this.withLock(dir, async () => {
      await this.ensureDir(dir);
      await atomicCompact(ops, dir, snapshot, stateJson);
    });
  }

  private async readStateJsonUnlocked<T>(dir: string): Promise<T | null> {
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

  async readStateJson<T>(dir: string): Promise<T | null> {
    return this.withLock(dir, () => this.readStateJsonUnlocked<T>(dir));
  }

  async listDocDirs(): Promise<string[]> {
    const docsDir = join(this.root, META_DIR, "crdt/docs");
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
    const full = join(this.root, path);
    return this.withLock(full, async () => {
      try {
        return new Uint8Array(await fs.readFile(full));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    });
  }

  async writeMaterializedAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const full = join(this.root, path);
    await this.withLock(full, async () => {
      await this.ensureDir(dirname(full));
      await fs.writeFile(full + ".tmp", bytes);
      await fs.rename(full + ".tmp", full);
    });
  }

  async listMaterializedPaths(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const entry of entries) {
        if (rel === "" && isMetaDirName(entry.name)) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), relPath);
        } else {
          out.push(relPath);
        }
      }
    };
    await walk(this.root, "");
    return out;
  }

  async listMaterializedDirectories(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (rel === "" && isMetaDirName(entry.name)) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        out.push(relPath);
        await walk(join(dir, entry.name), relPath);
      }
    };
    await walk(this.root, "");
    return out;
  }

  async removeMaterialized(path: string): Promise<void> {
    assertDeletable(path);
    const full = join(this.root, path);
    await this.withLock(full, async () => {
      await fs.rm(full, { force: true });
      // Best-effort: prune now-empty parent directories, never past the vault root.
      let dir = dirname(full);
      while (dir.length > this.root.length && dir.startsWith(this.root)) {
        try {
          const entries = await fs.readdir(dir);
          if (entries.length > 0) break;
          await fs.rmdir(dir);
          dir = dirname(dir);
        } catch {
          break;
        }
      }
    });
  }

  async removeEmptyMaterializedDirectories(path: string): Promise<void> {
    assertDeletable(path);
    const relative = normalizeFilePath(path);
    if (!relative) return;
    if (relative.split("/").some(isMetaDirName)) {
      throw new Error(`refusing to prune vault metadata path "${path}"`);
    }
    const full = join(this.root, relative);

    await this.withLock(full, async () => {
      const prune = async (directory: string): Promise<void> => {
        let stat: import("fs").Stats;
        try {
          stat = await fs.lstat(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (!stat.isDirectory()) return;

        let entries: import("fs").Dirent[];
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }

        for (const entry of entries) {
          if (entry.isDirectory()) await prune(join(directory, entry.name));
        }

        try {
          if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        }
      };

      await prune(full);
    });
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
  // Compaction removes the superseded `updates/` directory as a whole and
  // stray `.tmp` files; nothing else is ever removed recursively.
  rm: async (p) => {
    await fs.rm(p, { recursive: p.endsWith("/updates"), force: true });
  },
};

export class NodeFSStore implements PersistedDocStore {
  private backend: NodePersistBackend;

  constructor(root: string) {
    this.backend = new NodePersistBackend(root);
  }

  private dir(docId: string): string {
    return join(this.backend.root, META_DIR, "crdt/docs", docId);
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

  listMaterializedPaths(): Promise<string[]> {
    return this.backend.listMaterializedPaths();
  }

  listMaterializedDirectories(): Promise<string[]> {
    return this.backend.listMaterializedDirectories();
  }

  removeMaterialized(path: string): Promise<void> {
    return this.backend.removeMaterialized(path);
  }

  removeEmptyMaterializedDirectories(path: string): Promise<void> {
    return this.backend.removeEmptyMaterializedDirectories(path);
  }
}

export class NodeVaultTreeStore implements VaultTreeStore {
  private backend: NodePersistBackend;

  constructor(root: string) {
    this.backend = new NodePersistBackend(root);
  }

  private dir(): string {
    return join(this.backend.root, META_DIR, "crdt/vault");
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
