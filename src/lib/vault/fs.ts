import { META_DIR } from "@/lib/core/paths";

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
  /**
   * Remove a file, or an empty directory. A non-empty directory is only
   * removed with `{ recursive: true }` — deleting a subtree must be asked
   * for explicitly, so a wrong path can't take a whole tree with it.
   * Refuses the vault root and the reserved metadata directories.
   */
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;

  /** Non-recursive directory listing. */
  readdir(path: string): Promise<{ dirs: string[]; files: string[] }>;

  /** Recursively walk every file in the vault, skipping the top-level metadata directory. */
  walk(): AsyncGenerator<{ path: string }>;
}

/**
 * Paths no delete may ever target: the vault root and the reserved
 * metadata directories that hold every document's CRDT state.
 */
const PROTECTED_DELETE_PATHS = new Set([
  "",
  META_DIR,
  `${META_DIR}/crdt`,
  `${META_DIR}/crdt/docs`,
  `${META_DIR}/crdt/vault`,
]);

export function assertDeletable(path: string): void {
  const normalized = normalizeFilePath(path);
  if (PROTECTED_DELETE_PATHS.has(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`refusing to delete protected vault path "${path}"`);
  }
}

export function normalizeFilePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
}
