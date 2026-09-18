import { describe, expect, it, vi } from "vitest";
import { vaultPluginStorage } from "@/lib/plugins/vault-storage";
import type { VaultEngine } from "@/lib/vault/engine";

function makeEngineStub() {
  const files = new Map<string, Uint8Array>();
  return {
    docStore: {
      readMaterialized: vi.fn(async (path: string) => files.get(path) ?? null),
      writeMaterializedAtomic: vi.fn(async (path: string, bytes: Uint8Array) => {
        files.set(path, bytes);
      }),
    },
  } as unknown as VaultEngine;
}

describe("vaultPluginStorage", () => {
  it("reads through docStore.readMaterialized", async () => {
    const engine = makeEngineStub();
    const storage = vaultPluginStorage(engine);
    expect(await storage.read(".adhd/plugins.json")).toBeNull();
    await storage.write(".adhd/plugins.json", new TextEncoder().encode("{}"));
    expect(new TextDecoder().decode((await storage.read(".adhd/plugins.json"))!)).toBe("{}");
  });

  it("writes through docStore.writeMaterializedAtomic", async () => {
    const engine = makeEngineStub();
    const storage = vaultPluginStorage(engine);
    const bytes = new TextEncoder().encode("hello");
    await storage.write("path.json", bytes);
    expect(engine.docStore.writeMaterializedAtomic).toHaveBeenCalledWith("path.json", bytes);
  });
});
