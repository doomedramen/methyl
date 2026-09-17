import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { docIdForPath, normalizeNotePath, pathForDocId } from "@/lib/vault/note-path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "methyl-note-path-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function newEngine(): Promise<VaultEngine> {
  return VaultEngine.create(new NodeVaultTreeStore(tmpDir), new NodeFSStore(tmpDir));
}

describe("note path <-> document id", () => {
  it("round-trips a root note", async () => {
    const engine = await newEngine();
    const doc = engine.createDocument(undefined, "Alpha.md", "# Alpha");

    const path = pathForDocId(engine.tree, doc.id);
    expect(path).toBe("Alpha.md");
    expect(docIdForPath(engine.tree, path!)).toBe(doc.id);
  });

  it("round-trips a note inside a folder", async () => {
    const engine = await newEngine();
    const folder = engine.createFolder(undefined, "Projects");
    const doc = engine.createDocument(folder, "Beta.md", "# Beta");

    expect(pathForDocId(engine.tree, doc.id)).toBe("Projects/Beta.md");
    expect(docIdForPath(engine.tree, "Projects/Beta.md")).toBe(doc.id);
  });

  it("follows a note after it moves into a folder", async () => {
    const engine = await newEngine();
    const folder = engine.createFolder(undefined, "Projects");
    const doc = engine.createDocument(undefined, "Gamma.md", "# Gamma");
    const node = engine.tree.findByDocumentId(doc.id)!;

    await engine.moveNode(node.treeId, folder);

    expect(pathForDocId(engine.tree, doc.id)).toBe("Projects/Gamma.md");
    expect(docIdForPath(engine.tree, "Gamma.md")).toBeUndefined();
  });

  it("returns undefined for an unknown or deleted path", async () => {
    const engine = await newEngine();
    const doc = engine.createDocument(undefined, "Delta.md", "# Delta");
    expect(docIdForPath(engine.tree, "Nope.md")).toBeUndefined();

    await engine.deleteDocument(doc.id);
    expect(docIdForPath(engine.tree, "Delta.md")).toBeUndefined();
    expect(pathForDocId(engine.tree, doc.id)).toBeNull();
  });

  it("ignores surrounding and duplicated slashes", async () => {
    const engine = await newEngine();
    const folder = engine.createFolder(undefined, "Projects");
    const doc = engine.createDocument(folder, "Epsilon.md", "# Epsilon");

    expect(docIdForPath(engine.tree, "/Projects//Epsilon.md/")).toBe(doc.id);
    expect(normalizeNotePath(" /a//b.md ")).toBe("a/b.md");
    expect(docIdForPath(engine.tree, "   ")).toBeUndefined();
  });
});
