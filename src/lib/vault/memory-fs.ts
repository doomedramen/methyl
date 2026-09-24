import type { VaultFileSystem } from "@/lib/vault/fs";
import { assertDeletable, normalizeFilePath } from "@/lib/vault/fs";

/**
 * In-memory VaultFileSystem. Used by tests and server-side dev flows.
 * Emulates the OPFS semantics the stores rely on: path → bytes, atomic text
 * writes, and non-recursive directory listing.
 */
export class MemoryVaultFS implements VaultFileSystem {
  private files = new Map<string, Uint8Array>();

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
    this.files.set(normalizeFilePath(path), new Uint8Array(data));
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.files.set(
      normalizeFilePath(path),
      new TextEncoder().encode(text),
    );
  }

  async mkdir(_path: string): Promise<void> {
    // Directories are implicit in the flat map
  }

  async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
    assertDeletable(path);
    const key = normalizeFilePath(path);
    const children = [...this.files.keys()].filter((k) => k.startsWith(key + "/"));
    // Same rule as OPFS removeEntry: a non-empty directory needs recursive.
    if (children.length > 0 && options?.recursive !== true) {
      throw new DOMException(`"${path}" is a non-empty directory`, "InvalidModificationError");
    }
    this.files.delete(key);
    for (const k of children) this.files.delete(k);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(normalizeFilePath(path));
  }

  async readdir(path: string): Promise<{ dirs: string[]; files: string[] }> {
    const prefix = normalizeFilePath(path);
    const base = prefix ? `${prefix}/` : "";
    const dirs = new Set<string>();
    const files = new Set<string>();
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
      if (key === ".adhd" || key.startsWith(".adhd/")) continue;
      yield { path: key };
    }
  }
}
