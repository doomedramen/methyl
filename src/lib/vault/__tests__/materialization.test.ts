import { describe, it, expect } from "vitest";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";

async function newEngine(fs = new MemoryVaultFS()) {
  const treeStore = new OpfsVaultTreeStore(fs);
  const docStore = new OpfsDocStore(fs);
  const engine = await VaultEngine.create(treeStore, docStore);
  return { engine, fs, treeStore, docStore };
}

describe("materialization: disk mirrors the tree", () => {
  it("persistDocumentIncremental writes the .md at the current tree path", async () => {
    const { engine, fs } = await newEngine();
    const doc = engine.createDocument(undefined, "note.md", "hello");

    await engine.persistDocumentIncremental(doc.id);

    expect(await fs.readTextFile("note.md")).toBe("hello");
  });

  it("renaming a note moves the .md and deletes the old file", async () => {
    const { engine, fs } = await newEngine();
    const doc = engine.createDocument(undefined, "note.md", "hello");
    await engine.persistDocumentIncremental(doc.id);
    expect(await fs.exists("note.md")).toBe(true);

    await engine.renameDocument(doc.id, "Renamed");

    expect(await fs.exists("note.md")).toBe(false);
    expect(await fs.readTextFile("Renamed.md")).toBe("hello");
  });

  it("moving a note into a folder relocates the .md", async () => {
    const { engine, fs } = await newEngine();
    const folderId = engine.createFolder(undefined, "Projects");
    const doc = engine.createDocument(undefined, "note.md", "hello");
    await engine.persistDocumentIncremental(doc.id);

    const node = engine.tree.findByDocumentId(doc.id)!;
    await engine.moveNode(node.treeId, folderId);

    expect(await fs.exists("note.md")).toBe(false);
    expect(await fs.readTextFile("Projects/note.md")).toBe("hello");
  });

  it("renaming a folder relocates every note beneath it", async () => {
    const { engine, fs } = await newEngine();
    const folderId = engine.createFolder(undefined, "Old");
    const doc = engine.createDocument(folderId, "note.md", "hello");
    await engine.persistDocumentIncremental(doc.id);
    expect(await fs.exists("Old/note.md")).toBe(true);

    await engine.renameFolder(folderId, "New");

    expect(await fs.exists("Old/note.md")).toBe(false);
    expect(await fs.readTextFile("New/note.md")).toBe("hello");
  });

  it("deleting a note removes its materialised file", async () => {
    const { engine, fs } = await newEngine();
    const doc = engine.createDocument(undefined, "note.md", "hello");
    await engine.persistDocumentIncremental(doc.id);

    await engine.deleteDocument(doc.id);

    expect(await fs.exists("note.md")).toBe(false);
  });

  it("deleting a folder removes every contained .md", async () => {
    const { engine, fs } = await newEngine();
    const folderId = engine.createFolder(undefined, "Projects");
    const doc = engine.createDocument(folderId, "note.md", "hello");
    await engine.persistDocumentIncremental(doc.id);

    await engine.deleteFolder(folderId);

    expect(await fs.exists("Projects/note.md")).toBe(false);
  });

  describe("reconcileMaterialization", () => {
    it("re-materialises a doc whose file is missing", async () => {
      const { engine, fs } = await newEngine();
      const doc = engine.createDocument(undefined, "note.md", "hello");
      // No persist/materialize call yet — file doesn't exist on disk.
      expect(await fs.exists("note.md")).toBe(false);

      const result = await engine.reconcileMaterialization();

      expect(result.materialized).toContain("note.md");
      expect(await fs.readTextFile("note.md")).toBe("hello");
    });

    it("re-materialises a doc whose file content is stale", async () => {
      const { engine, fs } = await newEngine();
      const doc = engine.createDocument(undefined, "note.md", "hello");
      await engine.persistDocumentIncremental(doc.id);
      // Simulate a leftover legacy file whose content no longer matches.
      await fs.writeFile("note.md", new TextEncoder().encode("<!-- adhd:id=old --> hello"));

      const result = await engine.reconcileMaterialization();

      expect(result.materialized).toContain("note.md");
      expect(await fs.readTextFile("note.md")).toBe("hello");
    });

    it("deletes a materialised file with no corresponding tree node", async () => {
      const { engine, fs } = await newEngine();
      await fs.writeFile("orphan.md", new TextEncoder().encode("nobody owns me"));

      const result = await engine.reconcileMaterialization();

      expect(result.removed).toContain("orphan.md");
      expect(await fs.exists("orphan.md")).toBe(false);
    });

    it("never touches .adhd metadata", async () => {
      const { engine, fs } = await newEngine();
      await fs.writeFile(
        ".adhd/crdt/vault/snapshot.loro",
        new TextEncoder().encode("not-a-real-snapshot"),
      );

      const result = await engine.reconcileMaterialization();

      expect(result.removed).not.toContain(".adhd/crdt/vault/snapshot.loro");
      expect(await fs.exists(".adhd/crdt/vault/snapshot.loro")).toBe(true);
    });

    it("cleans up a stale path left behind after a rename made outside this session", async () => {
      // Simulate: a prior session renamed welcome.md -> Projects/welcome.md
      // in the tree but crashed before the old file was removed.
      const { engine, fs } = await newEngine();
      const folderId = engine.createFolder(undefined, "Projects");
      const doc = engine.createDocument(folderId, "welcome.md", "hi");
      await fs.writeFile("welcome.md", new TextEncoder().encode("hi"));
      // No entry in the in-memory materializedPaths map for this fresh
      // engine instance pointing at the stale root-level file, so this
      // exercises reconcile's orphan-path GC, not the rename-time cleanup.

      const result = await engine.reconcileMaterialization();

      expect(await fs.exists("welcome.md")).toBe(false);
      expect(await fs.readTextFile("Projects/welcome.md")).toBe("hi");
      expect(result.removed).toContain("welcome.md");
      void doc;
    });
  });
});

describe("materialization: CONTENT_KEY round-trip", () => {
  it("materialised bytes match the document's LoroText content exactly", async () => {
    const { engine, fs } = await newEngine();
    const doc = engine.createDocument(undefined, "note.md", "line one\nline two\n");
    await engine.persistDocumentIncremental(doc.id);

    const onDisk = await fs.readTextFile("note.md");
    const inMemory = engine.getDocument(doc.id)!.getText(CONTENT_KEY).toString();
    expect(onDisk).toBe(inMemory);
  });
});
