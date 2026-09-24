import { describe, expect, it } from "vitest";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { WriterGatedFS } from "@/lib/vault/gated-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";

async function seededVault() {
  const mem = new MemoryVaultFS();
  const writer = await VaultEngine.create(new OpfsVaultTreeStore(mem), new OpfsDocStore(mem), "local");
  const doc = writer.createDocument(undefined, "a.md", "hello");
  await writer.persistTree();
  await writer.persistDocumentIncremental(doc.id);
  await writer.reconcileMaterialization();
  return { mem, writer, docId: doc.id };
}

async function snapshotOf(mem: MemoryVaultFS): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string) => {
    const { dirs, files } = await mem.readdir(dir);
    for (const f of files) {
      const p = dir ? `${dir}/${f}` : f;
      out.set(p, new TextDecoder().decode((await mem.readFile(p))!));
    }
    for (const d of dirs) await walk(dir ? `${dir}/${d}` : d);
  };
  await walk("");
  return out;
}

describe("writer-lock gated file system (§12)", () => {
  it("a read-only tab opens and reads the vault without writing anything", async () => {
    const { mem, docId } = await seededVault();
    const before = await snapshotOf(mem);
    const gated = new WriterGatedFS(mem);
    const { engine } = await VaultEngine.open(new OpfsVaultTreeStore(gated), new OpfsDocStore(gated), "local");
    expect(engine.getDocument(docId)?.getText(CONTENT_KEY).toString()).toBe("hello");
    expect(await snapshotOf(mem)).toEqual(before);
  });

  it("a stale engine that lost the lock cannot change the store", async () => {
    const { mem, docId } = await seededVault();
    const gated = new WriterGatedFS(mem);
    gated.setWritable(true);
    const { engine: stale } = await VaultEngine.open(new OpfsVaultTreeStore(gated), new OpfsDocStore(gated), "local");
    gated.setWritable(false); // another tab stole the lock
    const before = await snapshotOf(mem);

    stale.getDocument(docId)!.getText(CONTENT_KEY).insert(0, "stale ");
    await expect(stale.persistDocumentIncremental(docId)).rejects.toThrow(/writer lock/);
    stale.createFolder(undefined, "Stale folder");
    await expect(stale.persistTree()).rejects.toThrow(/writer lock/);

    expect(await snapshotOf(mem)).toEqual(before);
  });

  it("writes go through again once the lock is held", async () => {
    const gated = new WriterGatedFS(new MemoryVaultFS());
    await expect(gated.writeFile("x.md", new Uint8Array([1]))).rejects.toThrow(/writer lock/);
    gated.setWritable(true);
    await gated.writeFile("x.md", new Uint8Array([1]));
    expect(await gated.exists("x.md")).toBe(true);
  });
});
