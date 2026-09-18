export interface PluginStorage {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** In-memory `PluginStorage` for unit tests. */
export class InMemoryPluginStorage implements PluginStorage {
  private files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
  }
}
