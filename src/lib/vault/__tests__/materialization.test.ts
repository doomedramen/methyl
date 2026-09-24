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
      engine.createDocument(undefined, "note.md", "hello");
      // No persist/materialize call yet — file doesn't exist on disk.
      expect(await fs.exists("note.md")).toBe(false);

      const result = await engine.reconcileMaterialization();

      expect(result.materialized).toContain("note.md");
      expect(await fs.readTextFile("note.md")).toBe("hello");
    });

    it("a lingering legacy adhd:id comment is stripped and re-materialised, even with no real content change", async () => {
      const { engine, fs } = await newEngine();
      const doc = engine.createDocument(undefined, "note.md", "hello");
      await engine.persistDocumentIncremental(doc.id);
      // Simulate a pre-sidecar-index leftover: same content, but the file
      // still carries the legacy id comment (e.g. never rewritten clean).
      await fs.writeFile(
        "note.md",
        new TextEncoder().encode(
          `<!-- adhd:id=${doc.id} -->\n\nhello`,
        ),
      );

      const result = await engine.reconcileMaterialization();

      expect(result.ingested.edited).toContain(doc.id);
      expect(await fs.readTextFile("note.md")).toBe("hello");
    });

    it("re-materialises a doc whose file content is externally edited (ingest, not overwrite)", async () => {
      const { engine, fs } = await newEngine();
      const doc = engine.createDocument(undefined, "note.md", "hello");
      await engine.persistDocumentIncremental(doc.id);
      // An external editor changed the file after the app last wrote it —
      // this must be absorbed into the CRDT, never clobbered.
      await fs.writeFile("note.md", new TextEncoder().encode("hello world"));

      const result = await engine.reconcileMaterialization();

      expect(result.ingested.edited).toContain(doc.id);
      expect(await fs.readTextFile("note.md")).toBe("hello world");
      expect(engine.getDocument(doc.id)!.getMarkdown()).toBe("hello world");
    });

    it("adopts a genuinely new external file as a document instead of deleting it", async () => {
      const { engine, fs } = await newEngine();
      await fs.writeFile("orphan.md", new TextEncoder().encode("nobody owns me"));

      const result = await engine.reconcileMaterialization();

      expect(result.ingested.created.length).toBe(1);
      expect(await fs.exists("orphan.md")).toBe(true);
      expect(await fs.readTextFile("orphan.md")).toBe("nobody owns me");
      const node = engine.tree.findByName("orphan.md")[0];
      expect(node?.documentId).toBe(result.ingested.created[0]);
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

describe("materialization: binary attachments", () => {
  it("creates, reads, and hashes an attachment under Attachments/", async () => {
    const { engine, fs } = await newEngine();
    const bytes = new Uint8Array([0, 1, 2, 255]);

    const node = await engine.createAttachment("pixel.png", bytes);

    expect(node.kind).toBe("binary");
    expect(node.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(node.size).toBe(bytes.byteLength);
    expect(node.mime).toBe("image/png");
    expect(await fs.readFile("Attachments/pixel.png")).toEqual(bytes);
    expect(await engine.readAttachment(node.treeId)).toEqual(bytes);
  });

  it("adopts ordinary files during reconciliation", async () => {
    const { engine, fs } = await newEngine();
    const bytes = new Uint8Array([5, 4, 3, 2, 1]);
    await fs.writeFile("exports/data.bin", bytes);

    const result = await engine.reconcileMaterialization();
    const treeId = engine.tree.resolvePath(["exports", "data.bin"]);

    expect(result.removed).not.toContain("exports/data.bin");
    expect(result.ingested.assetsCreated).toHaveLength(1);
    expect(engine.tree.getNode(treeId!)?.kind).toBe("binary");
    expect(await fs.readFile("exports/data.bin")).toEqual(bytes);
  });

  it("updates binary metadata when an attachment is edited externally", async () => {
    const { engine, fs } = await newEngine();
    const node = await engine.createAttachment("clip.bin", new Uint8Array([1, 2]));
    const replacement = new Uint8Array([9, 8, 7]);
    await fs.writeFile("Attachments/clip.bin", replacement);

    const result = await engine.ingestExternalAssets();
    const updated = engine.tree.getNode(node.treeId)!;

    expect(result.updated).toEqual([String(node.treeId)]);
    expect(updated.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(updated.size).toBe(replacement.byteLength);
    expect(await engine.readAttachment(node.treeId)).toEqual(replacement);
  });

  it("moves and deletes attachment bytes with their tree nodes", async () => {
    const { engine, fs } = await newEngine();
    const node = await engine.createAttachment("clip.mp4", new Uint8Array([4, 5, 6]));
    const folderId = engine.createFolder(undefined, "Projects");

    await engine.moveNode(node.treeId, folderId);
    expect(await fs.exists("Attachments/clip.mp4")).toBe(false);
    expect(await fs.exists("Projects/clip.mp4")).toBe(true);

    await engine.renameFolder(folderId, "Media");
    expect(await fs.exists("Projects/clip.mp4")).toBe(false);
    expect(await fs.exists("Media/clip.mp4")).toBe(true);

    await engine.deleteAttachment(node.treeId);
    expect(await fs.exists("Media/clip.mp4")).toBe(false);
    expect(engine.tree.getNode(node.treeId)).toBeUndefined();
  });

  it("adopts ordinary files placed in Attachments/ during reconciliation", async () => {
    const { engine, fs } = await newEngine();
    const bytes = new Uint8Array([9, 8, 7]);
    await fs.writeFile("Attachments/from-disk.pdf", bytes);

    const result = await engine.reconcileMaterialization();
    const node = engine.tree.findByName("from-disk.pdf")[0];

    expect(result.ingested.assetsCreated).toHaveLength(1);
    expect(node?.kind).toBe("binary");
    expect(await engine.readAttachment(node!.treeId)).toEqual(bytes);
  });

  it("adopts ordinary files anywhere in the vault during startup reconciliation", async () => {
    const { engine, fs } = await newEngine();
    const textBytes = new TextEncoder().encode("exported data");
    const imageBytes = new Uint8Array([1, 4, 9]);
    await fs.writeFile("exports/data.txt", textBytes);
    await fs.writeFile("Projects/diagram.png", imageBytes);
    await fs.writeFile(".obsidian/app.json", new TextEncoder().encode("metadata"));

    const result = await engine.reconcileMaterialization();
    const textId = engine.tree.resolvePath(["exports", "data.txt"]);
    const imageId = engine.tree.resolvePath(["Projects", "diagram.png"]);

    expect(result.ingested.assetsCreated).toHaveLength(2);
    expect(engine.tree.getNode(textId!)?.kind).toBe("binary");
    expect(engine.tree.getNode(textId!)?.size).toBe(textBytes.byteLength);
    expect(engine.tree.getNode(imageId!)?.mime).toBe("image/png");
    expect(await engine.readAttachment(imageId!)).toEqual(imageBytes);
    expect(engine.tree.resolvePath([".obsidian", "app.json"])).toBeUndefined();
  });
});
