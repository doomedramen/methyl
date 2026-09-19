import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-engine-actions-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function newEngine(): Promise<VaultEngine> {
  const treeStore = new NodeVaultTreeStore(tmpDir);
  const docStore = new NodeFSStore(tmpDir);
  return VaultEngine.create(treeStore, docStore);
}

describe("VaultEngine.renameDocument", () => {
  it("renames the tree file name and leaves content untouched", async () => {
    const engine = await newEngine();
    const doc = engine.createDocument(undefined, "note-1.md", "# Old title\n\nbody");

    await engine.renameDocument(doc.id, "New title");

    const markdown = engine.getDocument(doc.id)!.getText(CONTENT_KEY).toString();
    // Content is never rewritten by a rename — the display title comes
    // from the tree node's file name, not from an in-body heading.
    expect(markdown).toBe("# Old title\n\nbody");

    const node = engine.tree.findByDocumentId(doc.id);
    expect(node?.name).toBe("New title.md");
  });

  it("does not add or touch any heading when the document has none", async () => {
    const engine = await newEngine();
    const doc = engine.createDocument(undefined, "note-2.md", "no heading here");

    await engine.renameDocument(doc.id, "Given a title");

    const markdown = engine.getDocument(doc.id)!.getText(CONTENT_KEY).toString();
    expect(markdown).toBe("no heading here");
    const node = engine.tree.findByDocumentId(doc.id);
    expect(node?.name).toBe("Given a title.md");
  });

  it("auto-suffixes on a case-insensitive name clash with a sibling", async () => {
    const engine = await newEngine();
    engine.createDocument(undefined, "taken.md", "# one");
    const doc2 = engine.createDocument(undefined, "note-x.md", "# two");

    await engine.renameDocument(doc2.id, "TAKEN");

    const node = engine.tree.findByDocumentId(doc2.id);
    expect(node?.name).toBe("TAKEN 2.md");
  });
});

describe("VaultEngine.deleteDocument", () => {
  it("removes the note from the tree and in-memory documents", async () => {
    const engine = await newEngine();
    const doc = engine.createDocument(undefined, "note-3.md", "# gone soon");
    expect(engine.tree.findByDocumentId(doc.id)).toBeDefined();

    await engine.deleteDocument(doc.id);

    expect(engine.tree.findByDocumentId(doc.id)).toBeUndefined();
    expect(engine.getDocument(doc.id)).toBeUndefined();
    expect(engine.tree.documentIds()).not.toContain(doc.id);
  });

  it("throws for a document not tracked in the tree", async () => {
    const engine = await newEngine();
    await expect(engine.deleteDocument("not-a-real-id")).rejects.toThrow();
  });
});

describe("VaultEngine.search", () => {
  it("indexes body text and keeps the index after reopening", async () => {
    const engine = await newEngine();
    const doc = engine.createDocument(
      undefined,
      "searchable.md",
      "# Searchable\n\nThe body contains a phosphorescent meadow.",
    );
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "searchable.md");

    expect(engine.search("phosphorescent meadow").map((result) => result.id)).toContain(doc.id);

    doc.getText(CONTENT_KEY).insert(doc.getText(CONTENT_KEY).length, "\n\nA new comet trail.");
    await engine.persistDocumentIncremental(doc.id);
    expect(engine.search("comet trail").map((result) => result.id)).toContain(doc.id);

    const { engine: reopened } = await VaultEngine.open(
      new NodeVaultTreeStore(tmpDir),
      new NodeFSStore(tmpDir),
    );
    expect(reopened.search("comet trail").map((result) => result.id)).toContain(doc.id);
  });
});

describe("VaultEngine.backlinks", () => {
  it("tracks notes that link to the active note and survives reopening", async () => {
    const engine = await newEngine();
    const target = engine.createDocument(undefined, "Target.md", "# Target\n\nDestination");
    const source = engine.createDocument(undefined, "Source.md", "See [[Target]] for details.");
    await engine.persistTree();
    await engine.materializeDocument(target.id, "Target.md");
    await engine.materializeDocument(source.id, "Source.md");

    expect(engine.backlinksFor(target.id)).toEqual([
      expect.objectContaining({ from: source.id, fromTitle: "Source" }),
    ]);

    source.setText("The link was removed.");
    await engine.persistDocumentIncremental(source.id);
    expect(engine.backlinksFor(target.id)).toEqual([]);

    source.setText("See [[Target]] for details again.");
    await engine.persistDocumentIncremental(source.id);

    const { engine: reopened } = await VaultEngine.open(
      new NodeVaultTreeStore(tmpDir),
      new NodeFSStore(tmpDir),
    );
    expect(reopened.backlinksFor(target.id)).toEqual([
      expect.objectContaining({ from: source.id, fromTitle: "Source" }),
    ]);
  });
});
