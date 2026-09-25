import { isMetaDirName } from "@/lib/core/paths";
import type { VaultFileSystem } from "@/lib/vault/fs";
import { assertDeletable, normalizeFilePath } from "@/lib/vault/fs";

/**
 * In-memory VaultFileSystem. Used by tests and server-side dev flows.
 * Emulates the OPFS semantics the stores rely on, including explicit empty
 * directories and non-recursive directory listing.
 */
export class MemoryVaultFS implements VaultFileSystem {
  private files = new Map<string, Uint8Array>();
  private directories = new Set<string>();

  private ensureParentDirectories(path: string): void {
    const parts = normalizeFilePath(path).split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.directories.add(current);
    }
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const key = normalizeFilePath(path);
    const v = this.files.get(key);
    return v ? new Uint8Array(v) : null;
  }

  async readTextFile(path: string): Promise<string | null> {
    const bytes = await this.readFile(path);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const key = normalizeFilePath(path);
    this.ensureParentDirectories(key);
    this.files.set(key, new Uint8Array(data));
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    const key = normalizeFilePath(path);
    this.ensureParentDirectories(key);
    this.files.set(key, new TextEncoder().encode(text));
  }

  async mkdir(path: string): Promise<void> {
    const parts = normalizeFilePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.directories.add(current);
    }
  }

  async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
    assertDeletable(path);
    const key = normalizeFilePath(path);
    const prefix = `${key}/`;
    const fileChildren = [...this.files.keys()].filter((k) => k.startsWith(prefix));
    const directoryChildren = [...this.directories].filter((k) => k.startsWith(prefix));
    // Same rule as OPFS removeEntry: a non-empty directory needs recursive.
    if ((fileChildren.length > 0 || directoryChildren.length > 0) && options?.recursive !== true) {
      throw new DOMException(`"${path}" is a non-empty directory`, "InvalidModificationError");
    }
    this.files.delete(key);
    this.directories.delete(key);
    for (const child of fileChildren) this.files.delete(child);
    for (const child of directoryChildren) this.directories.delete(child);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(normalizeFilePath(path));
  }

  async readdir(path: string): Promise<{ dirs: string[]; files: string[] }> {
    const prefix = normalizeFilePath(path);
    const base = prefix ? `${prefix}/` : "";
    const dirs = new Set<string>();
    const files = new Set<string>();
    for (const key of this.directories) {
      if (!key.startsWith(base)) continue;
      const rest = key.slice(base.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      dirs.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    for (const key of this.files.keys()) {
      if (!key.startsWith(base)) continue;
      const rest = key.slice(base.length);
      const slash = rest.indexOf("/");
      if (slash === -1) files.add(rest);
      else dirs.add(rest.slice(0, slash));
    }
    return { dirs: [...dirs], files: [...files] };
  }

  /** Test helper: list every path currently stored. */
  allPaths(): string[] {
    return [...this.files.keys()].sort();
  }

  async *walk(): AsyncGenerator<{ path: string }> {
    for (const key of [...this.files.keys()].sort()) {
      if (isMetaDirName(key.split("/")[0]!)) continue;
      yield { path: key };
    }
  }
}
