import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-engine-folders-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function newEngine(): Promise<VaultEngine> {
  const treeStore = new NodeVaultTreeStore(tmpDir);
  const docStore = new NodeFSStore(tmpDir);
  return VaultEngine.create(treeStore, docStore);
}

describe("VaultEngine folder operations", () => {
  it("createFolder adds a directory node visible in tree.roots()", async () => {
    const engine = await newEngine();
    const id = engine.createFolder(undefined, "Projects");
    const node = engine.tree.getNode(id);
    expect(node?.kind).toBe("directory");
    expect(node?.name).toBe("Projects");
    expect(engine.tree.roots().some((n) => n.treeId === id)).toBe(true);
  });

  it("moveNode moves a note into a folder", async () => {
    const engine = await newEngine();
    const folderId = engine.createFolder(undefined, "Projects");
    const doc = engine.createDocument(undefined, "note.md", "# note");
    const node = engine.tree.findByDocumentId(doc.id)!;

    await engine.moveNode(node.treeId, folderId);

    const children = engine.tree.children(folderId);
    expect(children.map((c) => c.documentId)).toContain(doc.id);
  });

  it("moveNode reorders siblings via index", async () => {
    const engine = await newEngine();
    const a = engine.tree.addDirectory(undefined, "a");
    const b = engine.tree.addDirectory(undefined, "b");
    const c = engine.tree.addDirectory(undefined, "c");

    await engine.moveNode(c, undefined, 0);

    const order = engine.tree.roots().map((n) => n.treeId);
    expect(order).toEqual([c, a, b]);
  });

  it("moveNode refuses to drop a folder into its own descendant", async () => {
    const engine = await newEngine();
    const parent = engine.createFolder(undefined, "Parent");
    const child = engine.createFolder(parent, "Child");

    await expect(engine.moveNode(parent, child)).rejects.toThrow();
  });

  it("moveNode refuses to move a node into itself", async () => {
    const engine = await newEngine();
    const folder = engine.createFolder(undefined, "Solo");
    await expect(engine.moveNode(folder, folder)).rejects.toThrow();
  });

  it("moveNode auto-suffixes on a case-insensitive name clash at the destination", async () => {
    const engine = await newEngine();
    const folderId = engine.createFolder(undefined, "Projects");
    engine.createDocument(folderId, "note.md", "# existing");
    const moving = engine.createDocument(undefined, "NOTE.md", "# moving");

    const movingNode = engine.tree.findByDocumentId(moving.id)!;
    await engine.moveNode(movingNode.treeId, folderId);

    const renamed = engine.tree.getNode(movingNode.treeId);
    expect(renamed?.name).toBe("NOTE 2.md");
  });

  it("renameFolder renames the directory node", async () => {
    const engine = await newEngine();
    const id = engine.createFolder(undefined, "Old");
    await engine.renameFolder(id, "New");
    expect(engine.tree.getNode(id)?.name).toBe("New");
  });

  it("deleteFolder removes the folder and its contained documents", async () => {
    const engine = await newEngine();
    const folderId = engine.createFolder(undefined, "Projects");
    const doc = engine.createDocument(folderId, "note.md", "# note");

    await engine.deleteFolder(folderId);

    expect(engine.tree.getNode(folderId)).toBeUndefined();
    expect(engine.getDocument(doc.id)).toBeUndefined();
    expect(engine.tree.documentIds()).not.toContain(doc.id);
  });

  it("deleteFolder removes nested subfolders recursively", async () => {
    const engine = await newEngine();
    const outer = engine.createFolder(undefined, "Outer");
    const inner = engine.createFolder(outer, "Inner");
    const doc = engine.createDocument(inner, "note.md", "# note");

    await engine.deleteFolder(outer);

    expect(engine.tree.getNode(inner)).toBeUndefined();
    expect(engine.getDocument(doc.id)).toBeUndefined();
  });

  it("does not re-import empty directories after deleting their folder", async () => {
    const engine = await newEngine();
    mkdirSync(join(tmpDir, "__MACOSX", "Licences"), { recursive: true });

    await engine.ingestExternalFolders();
    const folder = engine.tree.findByName("__MACOSX").find((node) => node.kind === "directory");
    expect(folder).toBeDefined();

    await engine.deleteFolder(folder!.treeId);
    await engine.ingestExternalFolders();

    expect(engine.tree.findByName("__MACOSX")).toHaveLength(0);
  });
});
