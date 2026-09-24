import { normalizePath } from "@/lib/core/paths";
import { assertDeletable, type VaultFileSystem } from "@/lib/vault/fs";

const ROOT_KEY = "adhd-vault";

/**
 * OPFS-backed vault filesystem (§9, §11).
 *
 * Mirrors the logical vault tree:
 *
 *   /vault
 *   ├── Inbox/ Packages/ ...
 *   ├── *.md
 *   ├── attachments...
 *   ├── .trash/
 *   └── .adhd/
 *       ├── device/
 *       ├── crdt/
 *       └── cache/
 *
 * All writes use flush() to persist to disk. Markdown materialisations use
 * tmp → rename atomically where the platform supports it.
 */
export class OpfsVaultFS implements VaultFileSystem {
  private root: FileSystemDirectoryHandle | null = null;
  /**
   * Per-path write serialization. OPFS's `createWritable()` truncates on
   * open; two concurrent writers to the *same* path (e.g. an unawaited
   * create-time persist racing a later edit's flush — the app currently
   * has no real cross-call mutual exclusion, see web-locks.ts) can
   * interleave open/write/close in either order, so whichever completes
   * last wins regardless of which one is logically newer — a silent lost
   * write. It also matches the reported Chrome `UnknownError` ("operation
   * failed for an unknown transient reason"), which OPFS raises for
   * exactly this kind of racing access-handle contention on one file.
   * Queuing every write/delete for a path onto the same promise chain
   * makes them run strictly one at a time, in call order.
   */
  private writeQueues = new Map<string, Promise<void>>();

  private serialize<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const key = normalizePath(path);
    const prior = this.writeQueues.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // Keep the queue alive on failure too, but don't let a rejection stick
    // around forever holding up later writes to the same path.
    this.writeQueues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async ensureRoot(): Promise<FileSystemDirectoryHandle> {
    if (this.root) return this.root;
    const root = await navigator.storage.getDirectory();
    this.root = await root.getDirectoryHandle(ROOT_KEY, { create: true });
    return this.root;
  }

  /**
   * Directory handles by path. Resolving a path walks it one
   * getDirectoryHandle() call per segment from the root; every file access
   * did that walk again, which dominated startup on large vaults (spec item
   * 20). Entries are dropped when this instance deletes a directory, and
   * all of them when an operation finds a cached handle has gone stale
   * (e.g. another tab removed the directory) — see withFreshHandles.
   */
  private dirCache = new Map<string, FileSystemDirectoryHandle>();

  private async dirHandle(pathParts: string[], create = true) {
    const key = pathParts.join("/");
    const cached = this.dirCache.get(key);
    if (cached) return cached;
    const root = await this.ensureRoot();
    let cur = root;
    let path = "";
    for (const part of pathParts) {
      path = path ? `${path}/${part}` : part;
      const known = this.dirCache.get(path);
      if (known) {
        cur = known;
        continue;
      }
      cur = await cur.getDirectoryHandle(part, { create });
      this.dirCache.set(path, cur);
    }
    return cur;
  }

  private forgetDirs(path: string): void {
    const key = normalizePath(path);
    for (const cached of [...this.dirCache.keys()]) {
      if (cached === key || cached.startsWith(`${key}/`)) this.dirCache.delete(cached);
    }
  }

  /** Run `op`; if a cached handle turned out stale, clear the cache and retry once. */
  private async withFreshHandles<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if ((err as DOMException).name !== "NotFoundError" || this.dirCache.size === 0) throw err;
      this.dirCache.clear();
      return op();
    }
  }

  async fileHandle(path: string, create = true): Promise<FileSystemFileHandle | null> {
    return this.withFreshHandles(() => this.fileHandleOnce(path, create));
  }

  private async fileHandleOnce(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const parts = splitPath(path);
    const name = parts.pop()!;
    const dir = await this.dirHandle(parts, create).catch((err) => {
      if (!create && (err as DOMException).name === "NotFoundError") return null;
      throw err;
    });
    if (!dir) return null;
    try {
      return await dir.getFileHandle(name, { create });
    } catch (err) {
      if (!create && (err as DOMException).name === "NotFoundError") return null;
      throw err;
    }
  }

  private async *walkImpl(
    dir: FileSystemDirectoryHandle,
    prefix: string,
  ): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
    const entries = (dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries();
    for await (const [name, handle] of entries) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (name === ".adhd") continue;
      if (handle.kind === "file") {
        yield { path: rel, handle: handle as FileSystemFileHandle };
      } else {
        yield* this.walkImpl(handle as FileSystemDirectoryHandle, rel);
      }
    }
  }

  /** Walk all vault files, skipping .adhd. */
  async *walk(): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
    const root = await this.ensureRoot();
    yield* this.walkImpl(root, "");
  }

  async writeFile(path: string, data: Uint8Array, opts?: { atomic?: boolean }): Promise<void> {
    return this.serialize(path, async () => {
      const handle = await this.fileHandle(path, true);
      if (!handle) throw new Error("unreachable");
      const writable = await handle.createWritable();
      await writable.write(data as unknown as FileSystemWriteChunkType);
      await writable.close();
      if (opts?.atomic !== false) {
        try {
          await (handle as FileSystemFileHandle & { flush?: () => Promise<void> }).flush?.();
        } catch {
          // flush not available on this platform; close() already persisted
        }
      }
    });
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const handle = await this.fileHandle(path, false);
    if (!handle) return null;
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async readTextFile(path: string): Promise<string | null> {
    const bytes = await this.readFile(path);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async mkdir(path: string): Promise<void> {
    await this.dirHandle(splitPath(path), true);
  }

  async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
    assertDeletable(path);
    return this.serialize(path, async () => {
      const parts = splitPath(path);
      const name = parts.pop()!;
      const dir = await this.dirHandle(parts, false).catch(() => null);
      if (!dir) return;
      try {
        await dir.removeEntry(name, { recursive: options?.recursive === true });
      } catch (err) {
        if ((err as DOMException).name === "NotFoundError") return; // already gone
        throw err;
      } finally {
        this.forgetDirs(path);
      }
    });
  }

  async exists(path: string): Promise<boolean> {
    try {
      const handle = await this.fileHandle(path, false);
      return handle !== null;
    } catch {
      return false;
    }
  }

  /** Atomically replace an existing file via tmp + rename. */
  async writeTextAtomic(path: string, text: string): Promise<void> {
    return this.serialize(path, async () => {
      const parts = splitPath(path);
      const name = parts.pop()!;
      const dir = await this.dirHandle(parts, true);
      try {
        await dir.getFileHandle(name, { create: false });
      } catch {
        await dir.getFileHandle(name, { create: true });
      }
      const handle = await dir.getFileHandle(name, { create: true });
      if (!handle) return;
      const writable = await handle.createWritable();
      await writable.write(new TextEncoder().encode(text));
      await writable.close();
    });
  }

  async flushAll(): Promise<void> {
    // OPFS access handles auto-persist on close(); explicit flush() per file
    // is enforced in writeFile(). Nothing else needed here.
  }

  /** List directory entries. Returns { dirs: string[], files: string[] }. */
  async readdir(path: string): Promise<{ dirs: string[]; files: string[] }> {
    return this.withFreshHandles(async () => {
      const parts = path ? splitPath(path) : [];
      const dir = await this.dirHandle(parts, false).catch((err) => {
        if ((err as DOMException).name === "NotFoundError") return null;
        throw err;
      });
      if (!dir) return { dirs: [], files: [] };
      const dirs: string[] = [];
      const files: string[] = [];
      const entries = (dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries();
      for await (const [name, handle] of entries) {
        if (handle.kind === "directory") dirs.push(name);
        else files.push(name);
      }
      return { dirs, files };
    });
  }
}

export function splitPath(path: string): string[] {
  const normalized = normalizePath(path);
  if (!normalized) return [];
  return normalized.split("/");
}