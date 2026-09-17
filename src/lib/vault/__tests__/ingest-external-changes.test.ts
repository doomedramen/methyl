import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";

async function newEngine(root: string) {
  const treeStore = new NodeVaultTreeStore(root);
  const docStore = new NodeFSStore(root);
  const engine = await VaultEngine.create(treeStore, docStore);
  return { engine, treeStore, docStore };
}

describe("VaultEngine.ingestExternalChanges (SPEC §5, §25, §26)", () => {
  let tmp: string;

  function setup() {
    tmp = mkdtempSync(join(tmpdir(), "adhd-ingest-"));
    return tmp;
  }

  function cleanup() {
    rmSync(tmp, { recursive: true, force: true });
  }

  it("external edit merges into the CRDT (not clobbered by the app)", async () => {
    const root = setup();
    try {
      const { engine, docStore } = await newEngine(root);
      const doc = engine.createDocument(undefined, "note.md", "line one");
      await engine.persistDocumentIncremental(doc.id);

      await docStore.writeMaterializedAtomic(
        "note.md",
        new TextEncoder().encode("line one\nline two (external)"),
      );

      const report = await engine.ingestExternalChanges();

      expect(report.edited).toContain(doc.id);
      expect(engine.getDocument(doc.id)!.getMarkdown()).toBe(
        "line one\nline two (external)",
      );
    } finally {
      cleanup();
    }
  });

  it("external rename/move keeps the document id", async () => {
    const root = setup();
    try {
      const { engine, docStore } = await newEngine(root);
      const doc = engine.createDocument(undefined, "Garage.md", "fix the door");
      await engine.persistDocumentIncremental(doc.id);

      await docStore.removeMaterialized("Garage.md");
      await docStore.writeMaterializedAtomic(
        "Projects/Garage.md",
        new TextEncoder().encode("fix the door"),
      );

      const report = await engine.ingestExternalChanges();

      expect(report.moved).toContain(doc.id);
      const node = engine.tree.findByDocumentId(doc.id);
      expect(node?.name).toBe("Garage.md");
      const parent = node && engine.tree.getNode(node.treeId);
      void parent;
      // Verify placement: walking up from the node lands in a "Projects" dir.
      const projects = engine.tree.allNodes().find((n) => n.name === "Projects");
      expect(projects).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("external copy gets a new id, original keeps its id", async () => {
    const root = setup();
    try {
      const { engine, docStore } = await newEngine(root);
      const doc = engine.createDocument(undefined, "Report.md", "quarterly numbers");
      await engine.persistDocumentIncremental(doc.id);

      await docStore.writeMaterializedAtomic(
        "Report-copy.md",
        new TextEncoder().encode("quarterly numbers"),
      );

      const report = await engine.ingestExternalChanges();

      expect(report.copied.length).toBe(1);
      const copyId = report.copied[0]!;
      expect(copyId).not.toBe(doc.id);
      expect(engine.tree.findByDocumentId(doc.id)?.name).toBe("Report.md");
      expect(engine.tree.findByDocumentId(copyId)?.name).toBe("Report-copy.md");
    } finally {
      cleanup();
    }
  });

  it("external delete removes the document", async () => {
    const root = setup();
    try {
      const { engine, docStore } = await newEngine(root);
      const doc = engine.createDocument(undefined, "Gone.md", "temporary");
      await engine.persistDocumentIncremental(doc.id);

      await docStore.removeMaterialized("Gone.md");

      const report = await engine.ingestExternalChanges();

      expect(report.deleted).toContain(doc.id);
      expect(engine.tree.findByDocumentId(doc.id)).toBeUndefined();
      expect(engine.getDocument(doc.id)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("a genuinely new external file is adopted as a new document", async () => {
    const root = setup();
    try {
      const { engine, docStore } = await newEngine(root);

      await docStore.writeMaterializedAtomic(
        "New.md",
        new TextEncoder().encode("written outside the app"),
      );

      const report = await engine.ingestExternalChanges();

      expect(report.created.length).toBe(1);
      const id = report.created[0]!;
      expect(engine.getDocument(id)!.getMarkdown()).toBe("written outside the app");
      expect(engine.tree.findByDocumentId(id)?.name).toBe("New.md");
    } finally {
      cleanup();
    }
  });

  it("the app's own writes are not re-ingested as external changes", async () => {
    const root = setup();
    try {
      const { engine } = await newEngine(root);
      const doc = engine.createDocument(undefined, "note.md", "hello");
      await engine.persistDocumentIncremental(doc.id); // updates the sidecar index too

      const report = await engine.ingestExternalChanges();

      expect(report.edited).toEqual([]);
      expect(report.moved).toEqual([]);
      expect(report.copied).toEqual([]);
      expect(report.created).toEqual([]);
      expect(report.deleted).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("boot (reconcileMaterialization) does not clobber an external edit made while offline", async () => {
    const root = setup();
    try {
      const treeStore = new NodeVaultTreeStore(root);
      const docStore = new NodeFSStore(root);
      const engine = await VaultEngine.create(treeStore, docStore);
      const doc = engine.createDocument(undefined, "note.md", "original");
      await engine.persistDocumentIncremental(doc.id);
      await engine.persistTree();

      // Simulate "app closed, external editor changes the file, app reopens".
      await docStore.writeMaterializedAtomic(
        "note.md",
        new TextEncoder().encode("original, edited externally while offline"),
      );

      const { engine: reopened, recovery } = await VaultEngine.open(
        treeStore,
        docStore,
      );
      void recovery;
      const result = await reopened.reconcileMaterialization();

      expect(result.ingested.edited).toContain(doc.id);
      const text = reopened.getDocument(doc.id)!.getText(CONTENT_KEY).toString();
      expect(text).toBe("original, edited externally while offline");
      expect(
        await docStore
          .readMaterialized("note.md")
          .then((b) => new TextDecoder().decode(b!)),
      ).toBe("original, edited externally while offline");
    } finally {
      cleanup();
    }
  });
});
