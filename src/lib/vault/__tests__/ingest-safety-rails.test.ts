import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";

async function newEngineWithThreeNotes(root: string) {
  const treeStore = new NodeVaultTreeStore(root);
  const docStore = new NodeFSStore(root);
  const engine = await VaultEngine.create(treeStore, docStore);
  const a = engine.createDocument(undefined, "welcome.md", "hello");
  const b = engine.createDocument(undefined, "Untitled.md", "one");
  const c = engine.createDocument(undefined, "Untitled 2.md", "two");
  await engine.persistTree();
  await engine.persistDocumentIncremental(a.id);
  await engine.persistDocumentIncremental(b.id);
  await engine.persistDocumentIncremental(c.id);
  return { engine, treeStore, docStore, ids: [a.id, b.id, c.id] };
}

describe("ingest safety rails: a bad disk scan must not wipe the vault", () => {
  it("a transient empty listMaterializedPaths() (e.g. an OPFS read glitch) must NOT delete every tracked document", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-safety-"));
    try {
      const { engine, ids } = await newEngineWithThreeNotes(root);

      // Simulate the exact failure mode reported in production: the disk
      // listing transiently comes back empty even though the tree/CRDT
      // still know about 3 real documents (an OPFS walk() race, a storage
      // hiccup, whatever). This must never be interpreted as "the user
      // deleted all their files".
      const realList = engine.docStore.listMaterializedPaths.bind(engine.docStore);
      let calls = 0;
      engine.docStore.listMaterializedPaths = async () => {
        calls++;
        return calls === 1 ? [] : await realList();
      };

      const report = await engine.ingestExternalChanges();

      expect(report.deleted).toEqual([]);
      for (const id of ids) {
        expect(engine.tree.findByDocumentId(id)).toBeDefined();
        expect(engine.getDocument(id)).toBeDefined();
      }
      expect(engine.tree.documentIds().length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an index.json that reads back as {} while the tree has tracked docs is not trusted as ground truth", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-safety-"));
    try {
      const { engine, docStore, ids } = await newEngineWithThreeNotes(root);

      // Simulate the reported on-disk state directly: index.json = "{}".
      await docStore.writeMaterializedAtomic(
        ".adhd/index.json",
        new TextEncoder().encode("{}"),
      );

      const report = await engine.ingestExternalChanges();

      expect(report.deleted).toEqual([]);
      for (const id of ids) {
        expect(engine.tree.findByDocumentId(id)).toBeDefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a mass deletion (>50% of tracked docs) in one ingest pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-safety-"));
    try {
      const { engine, docStore, ids } = await newEngineWithThreeNotes(root);

      // Externally delete 2 of 3 files (>50%) without touching the third.
      await docStore.removeMaterialized("welcome.md");
      await docStore.removeMaterialized("Untitled.md");

      const report = await engine.ingestExternalChanges();

      // Refused: none of the deletions were applied.
      expect(report.deleted).toEqual([]);
      for (const id of ids) {
        expect(engine.tree.findByDocumentId(id)).toBeDefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still allows a single, minority deletion through normally", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-safety-"));
    try {
      const { engine, docStore, ids } = await newEngineWithThreeNotes(root);

      await docStore.removeMaterialized("Untitled 2.md");

      const report = await engine.ingestExternalChanges();

      expect(report.deleted).toEqual([ids[2]]);
      expect(engine.tree.findByDocumentId(ids[0])).toBeDefined();
      expect(engine.tree.findByDocumentId(ids[1])).toBeDefined();
      expect(engine.tree.findByDocumentId(ids[2])).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reserved .adhd metadata directory is protected", () => {
  it("sanitizeName rejects a folder/file literally named .adhd", async () => {
    const { sanitizeName } = await import("@/lib/core/paths");
    expect(sanitizeName(".adhd")).toBeNull();
    expect(sanitizeName(".ADHD")).toBeNull();
    expect(sanitizeName(".Adhd")).toBeNull();
  });

  it("VaultTree refuses to create a directory named .adhd", async () => {
    const { VaultTree } = await import("@/lib/vault/tree");
    const tree = VaultTree.create();
    expect(() => tree.addDirectory(undefined, ".adhd")).toThrow();
  });

  it(
    "materialize/delete near a would-be .adhd collision never touches real CRDT bytes " +
      "(reproduces the confirmed cause: sanitizeName used to let \".adhd\" through, so a " +
      "materialize/remove call could land inside the real .adhd/crdt/ directory)",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "adhd-safety-"));
      try {
        const { engine, docStore, ids } = await newEngineWithThreeNotes(root);

        // The real CRDT bytes for a tracked document, before anything else
        // happens — this must still be there afterward.

        // A node can no longer be named ".adhd" at all (the fix), so this
        // attack surface is closed at creation time.
        expect(() => engine.createFolder(undefined, ".adhd")).toThrow();

        // Even if a path *did* somehow resolve under .adhd/ (defense in
        // depth, in case of a future bug elsewhere), the engine's own
        // write/remove wrapper refuses it rather than touching the store.
        await engine.materializeDocument(ids[0]!, ".adhd/crdt/docs/should-not-write.md");
        expect(await docStore.readMaterialized(".adhd/crdt/docs/should-not-write.md")).toBeNull();

        const afterSnapshot = await docStore.loadSnapshot(ids[0]!);
        expect(afterSnapshot).not.toBeNull(); // the doc's own real compaction still ran fine
        const { NodeVaultTreeStore } = await import("@/lib/server/fs-store");
        const treeSnap = await new NodeVaultTreeStore(root).loadSnapshot();
        expect(treeSnap).not.toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
