import type { VaultFileSystem } from "@/lib/vault/fs";

/**
 * Wraps a VaultFileSystem so writes and deletes only go through while this
 * tab holds the vault's writer lock (SPEC §12). A read-only tab — or a
 * writer whose lock was just stolen, in the moments before it reloads —
 * then cannot touch the store at all, whatever code path tries: the UI
 * being read-only is not relied on for safety.
 */
export class WriterGatedFS implements VaultFileSystem {
  private writable = false;

  constructor(private readonly inner: VaultFileSystem) {}

  /** Allow or stop writes. Called when the writer lock is gained or lost. */
  setWritable(writable: boolean): void {
    this.writable = writable;
  }

  get isWritable(): boolean {
    return this.writable;
  }

  private check(op: string, path: string): void {
    if (!this.writable) {
      throw new Error(`[vault] ${op} "${path}" refused: this tab does not hold the vault's writer lock`);
    }
  }

  readFile(path: string) {
    return this.inner.readFile(path);
  }

  readTextFile(path: string) {
    return this.inner.readTextFile(path);
  }

  async writeFile(path: string, data: Uint8Array) {
    this.check("write", path);
    return this.inner.writeFile(path, data);
  }

  async writeTextAtomic(path: string, text: string) {
    this.check("write", path);
    return this.inner.writeTextAtomic(path, text);
  }

  async mkdir(path: string) {
    this.check("mkdir", path);
    return this.inner.mkdir(path);
  }

  async delete(path: string, options?: { recursive?: boolean }) {
    this.check("delete", path);
    return this.inner.delete(path, options);
  }

  exists(path: string) {
    return this.inner.exists(path);
  }

  readdir(path: string) {
    return this.inner.readdir(path);
  }

  walk() {
    return this.inner.walk();
  }
}
