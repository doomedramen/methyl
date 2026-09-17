import { describe, it, expect } from "vitest";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { writeSeedMarker, readSeedMarker, maybeDropUntouchedSeed } from "@/lib/browser/seed-marker";

const WELCOME = "---\ntitle: Welcome\n---\n\n# Welcome\n";

async function newVaultWithSeed(fs: MemoryVaultFS) {
  const treeStore = new OpfsVaultTreeStore(fs);
  const docStore = new OpfsDocStore(fs);
  const engine = await VaultEngine.create(treeStore, docStore, "local");
  const doc = engine.createDocument(undefined, "welcome.md", WELCOME);
  await engine.persistTree();
  await engine.persistDocumentIncremental(doc.id);
  await writeSeedMarker(fs, doc.id, WELCOME);
  return { engine, docId: doc.id };
}

describe("seed marker round-trip", () => {
  it("reads back what was written", async () => {
    const fs = new MemoryVaultFS();
    const { docId } = await newVaultWithSeed(fs);
    const marker = await readSeedMarker(fs);
    expect(marker?.documentId).toBe(docId);
    expect(marker?.contentSha256).toBeTruthy();
  });

  it("returns null when nothing was ever seeded", async () => {
    const fs = new MemoryVaultFS();
    expect(await readSeedMarker(fs)).toBeNull();
  });
});

describe("maybeDropUntouchedSeed", () => {
  it("drops the untouched seed note when the server already has content", async () => {
    const fs = new MemoryVaultFS();
    const { engine, docId } = await newVaultWithSeed(fs);

    await maybeDropUntouchedSeed(fs, engine, async () => true);

    expect(engine.tree.documentIds()).not.toContain(docId);
    expect(engine.tree.documentIds().length).toBe(0);
  });

  it("keeps the seed note when the server is empty", async () => {
    const fs = new MemoryVaultFS();
    const { engine, docId } = await newVaultWithSeed(fs);

    await maybeDropUntouchedSeed(fs, engine, async () => false);

    expect(engine.tree.documentIds()).toContain(docId);
  });

  it("keeps the seed note if it was edited (content hash no longer matches)", async () => {
    const fs = new MemoryVaultFS();
    const { engine, docId } = await newVaultWithSeed(fs);

    const doc = engine.getDocument(docId)!;
    doc.doc.commit();
    doc.getText("content").insert(0, "I changed this note.\n");
    doc.doc.commit();
    await engine.persistDocumentIncremental(docId);

    await maybeDropUntouchedSeed(fs, engine, async () => true);

    expect(engine.tree.documentIds()).toContain(docId);
  });

  it("keeps the seed note if other notes/folders exist alongside it", async () => {
    const fs = new MemoryVaultFS();
    const { engine, docId } = await newVaultWithSeed(fs);
    engine.createDocument(undefined, "another.md", "hello\n");
    await engine.persistTree();

    await maybeDropUntouchedSeed(fs, engine, async () => true);

    expect(engine.tree.documentIds()).toContain(docId);
  });

  it("only ever checks/acts once — a second call is a no-op even if conditions would otherwise apply", async () => {
    const fs = new MemoryVaultFS();
    const { engine, docId } = await newVaultWithSeed(fs);

    let calls = 0;
    const serverHasContent = async () => {
      calls++;
      return true;
    };

    await maybeDropUntouchedSeed(fs, engine, serverHasContent);
    expect(engine.tree.documentIds()).not.toContain(docId);
    expect(calls).toBe(1);

    // Recreate the tracked-but-now-absent doc id scenario is moot — just
    // confirm the second call doesn't even reach serverHasContent again.
    await maybeDropUntouchedSeed(fs, engine, serverHasContent);
    expect(calls).toBe(1);
  });

  it("does nothing when no seed was ever recorded (vault.ts skipped seeding, or a legacy vault predates this feature)", async () => {
    const fs = new MemoryVaultFS();
    const treeStore = new OpfsVaultTreeStore(fs);
    const docStore = new OpfsDocStore(fs);
    const engine = await VaultEngine.create(treeStore, docStore, "local");
    const doc = engine.createDocument(undefined, "notes.md", "hi\n");
    await engine.persistTree();

    await maybeDropUntouchedSeed(fs, engine, async () => true);

    expect(engine.tree.documentIds()).toContain(doc.id);
  });
});
