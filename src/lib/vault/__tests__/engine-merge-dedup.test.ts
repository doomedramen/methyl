import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine, buildPathFromNode } from "@/lib/vault/engine";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-merge-dedup-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function newEngine(dir: string): Promise<VaultEngine> {
  const treeStore = new NodeVaultTreeStore(dir);
  const docStore = new NodeFSStore(dir);
  return VaultEngine.create(treeStore, docStore, "shared");
}

/**
 * These tests cover VaultEngine.resolveTreeNameCollisions() /
 * VaultTree.resolveNameCollisions() — a *real* CRDT tree rename applied
 * once a foreign tree merge is detected, not a virtual per-call path
 * computation (an earlier version of buildPathFromNode tried that; it was
 * unsound — see resolveTreeNameCollisions' doc comment in engine.ts for
 * why a purely-computed-at-materialize-time approach can silently
 * overwrite an already-written file when the "winner" changes between
 * calls). The rename is a real edit, so it propagates through normal tree
 * sync and every replica converges on it.
 */
describe("post-merge sibling name collisions", () => {
  it("gives two independently-created same-named documents distinct tree names and materialized paths after merge", async () => {
    // Two devices, both offline, each creating their own "welcome.md" in
    // the vault root before ever syncing — exactly what two fresh Methyl
    // installs configured against the same server produce (each generates
    // its own random document id, so VaultTree's own local-op dedup never
    // runs against the other device's node).
    const dirA = mkdtempSync(join(tmpdir(), "adhd-merge-dedup-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "adhd-merge-dedup-b-"));
    try {
      const engineA = await newEngine(dirA);
      const docA = engineA.createDocument(undefined, "welcome.md", "device A's welcome\n");
      engineA.getDocument(docA.id)!.doc.commit();
      engineA.tree.doc.commit();

      const engineB = await newEngine(dirB);
      const docB = engineB.createDocument(undefined, "welcome.md", "device B's welcome\n");
      engineB.getDocument(docB.id)!.doc.commit();
      engineB.tree.doc.commit();

      // Merge B's tree into A's (simulating what sync would deliver) —
      // before resolution, the tree legitimately has two nodes literally
      // named "welcome.md".
      engineA.tree.doc.import(engineB.tree.exportUpdates());
      engineA.tree.doc.commit();
      expect(engineA.tree.findByDocumentId(docA.id)!.name.toLowerCase()).toBe("welcome.md");
      expect(engineA.tree.findByDocumentId(docB.id)!.name.toLowerCase()).toBe("welcome.md");

      const renamed = await engineA.resolveTreeNameCollisions();
      expect(renamed.length).toBe(1);

      const nodeA = engineA.tree.findByDocumentId(docA.id)!;
      const nodeB = engineA.tree.findByDocumentId(docB.id)!;
      const names = [nodeA.name, nodeB.name].sort();
      expect(names).toEqual(["welcome 2.md", "welcome.md"]);

      // Deterministic tie-break: the document with the lexicographically
      // SMALLER id keeps the plain name.
      const winnerIsA = docA.id < docB.id;
      expect(nodeA.name).toBe(winnerIsA ? "welcome.md" : "welcome 2.md");
      expect(nodeB.name).toBe(winnerIsA ? "welcome 2.md" : "welcome.md");

      // The materialized paths now come straight from the (now-distinct)
      // tree names.
      const pathA = buildPathFromNode(engineA.tree, nodeA);
      const pathB = buildPathFromNode(engineA.tree, nodeB);
      expect(pathA).not.toBe(pathB);

      // Idempotent: running it again is a no-op.
      expect(await engineA.resolveTreeNameCollisions()).toEqual([]);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("materializing both merged documents writes two distinct files, never overwriting one with the other", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "adhd-merge-dedup-mat-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "adhd-merge-dedup-mat-b-"));
    try {
      const engineA = await newEngine(dirA);
      const docA = engineA.createDocument(undefined, "notes.md", "A content\n");
      engineA.getDocument(docA.id)!.doc.commit();
      engineA.tree.doc.commit();

      const engineB = await newEngine(dirB);
      const docB = engineB.createDocument(undefined, "notes.md", "B content\n");
      engineB.getDocument(docB.id)!.doc.commit();
      engineB.tree.doc.commit();

      engineA.tree.doc.import(engineB.tree.exportUpdates());
      engineA.tree.doc.commit();

      // engineA only knows its own doc's content locally; bring B's doc
      // content over too, as a real sync would.
      const bDoc = engineB.getDocument(docB.id)!;
      await engineA.importDocumentUpdate(docB.id, bDoc.doc.export({ mode: "snapshot" }));

      await engineA.resolveTreeNameCollisions();

      const nodeA = engineA.tree.findByDocumentId(docA.id)!;
      const nodeB = engineA.tree.findByDocumentId(docB.id)!;
      const pathA = buildPathFromNode(engineA.tree, nodeA)!;
      const pathB = buildPathFromNode(engineA.tree, nodeB)!;
      expect(pathA).not.toBe(pathB);

      await engineA.materializeDocument(docA.id, pathA);
      await engineA.materializeDocument(docB.id, pathB);

      expect(existsSync(join(dirA, pathA))).toBe(true);
      expect(existsSync(join(dirA, pathB))).toBe(true);
      const contentAtPathA = readFileSync(join(dirA, pathA), "utf8");
      const contentAtPathB = readFileSync(join(dirA, pathB), "utf8");
      expect(new Set([contentAtPathA, contentAtPathB])).toEqual(
        new Set(["A content\n", "B content\n"]),
      );
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("three-way collisions get distinct suffixes ' 2', ' 3', ... in deterministic order", async () => {
    const engine = await newEngine(tmpDir);
    // Fabricate a post-merge-like state directly: three sibling nodes with
    // the identical stored name, as three independent offline peers would
    // produce (VaultTree's local dedup never ran against each other).
    const doc1 = engine.createDocument(undefined, "one.md", "one\n");
    const doc2 = engine.createDocument(undefined, "two.md", "two\n");
    const doc3 = engine.createDocument(undefined, "three.md", "three\n");
    const tree = engine.tree.tree;
    for (const id of [doc1.id, doc2.id, doc3.id]) {
      const node = engine.tree.findByDocumentId(id)!;
      tree.getNodeByID(node.treeId)!.data.set("name", "dup.md");
    }
    engine.tree.doc.commit();

    const renamed = await engine.resolveTreeNameCollisions();
    expect(renamed.length).toBe(2); // one node keeps the plain name

    const names = [doc1, doc2, doc3]
      .map((d) => engine.tree.findByDocumentId(d.id)!.name)
      .sort();
    expect(names).toEqual(["dup 2.md", "dup 3.md", "dup.md"]);

    // Deterministic tie-break order: sorted by document id.
    const byId = [doc1, doc2, doc3].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const expectedNames = ["dup.md", "dup 2.md", "dup 3.md"];
    byId.forEach((d, i) => {
      expect(engine.tree.findByDocumentId(d.id)!.name).toBe(expectedNames[i]);
    });

    // Idempotent.
    expect(await engine.resolveTreeNameCollisions()).toEqual([]);
  });
});
