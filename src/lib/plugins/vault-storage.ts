import type { VaultEngine } from "@/lib/vault/engine";
import type { PluginStorage } from "@/lib/plugins/storage";

/** `PluginStorage` backed by the real vault's materialized-file store. */
export function vaultPluginStorage(engine: VaultEngine): PluginStorage {
  return {
    async read(path: string): Promise<Uint8Array | null> {
      const bytes = await engine.docStore.readMaterialized(path);
      return bytes ?? null;
    },
    async write(path: string, bytes: Uint8Array): Promise<void> {
      await engine.docStore.writeMaterializedAtomic(path, bytes);
    },
  };
}
