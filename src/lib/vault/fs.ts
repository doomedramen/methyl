/**
 * Vault filesystem abstraction shared by OPFS (browser) and Memory (tests/dev).
 * Search, derived indexes, and the OPFS stores program against this, not the
 * concrete OPFS class, so they are testable without a browser.
 */
export interface VaultFileSystem {
  readFile(path: string): Promise<Uint8Array | null>;
  readTextFile(path: string): Promise<string | null>;

  writeFile(path: string, data: Uint8Array): Promise<void>;

  /** Atomically replace a UTF-8 text file. */
  writeTextAtomic(path: string, text: string): Promise<void>;

  mkdir(path: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;

  /** Non-recursive directory listing. */
  readdir(path: string): Promise<{ dirs: string[]; files: string[] }>;

  /** Recursively walk every file in the vault, skipping top-level `.adhd`. */
  walk(): AsyncGenerator<{ path: string }>;
}

export function normalizeFilePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
}
