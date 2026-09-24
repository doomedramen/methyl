import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";
import { readDiagnostics, recordDiagnostic } from "@/lib/vault/diagnostics";

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

describe("vault diagnostics ring buffer", () => {
  it("records an entry for deleteDocument, including id and path but not content", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-diag-"));
    try {
      const { engine, docStore, ids } = await newEngineWithThreeNotes(root);
      await engine.deleteDocument(ids[0]!);

      const entries = await readDiagnostics(docStore);
      const entry = entries.find((e) => e.op === "delete-document");
      expect(entry).toBeDefined();
      expect(entry!.detail).toContain(ids[0]!);
      expect(entry!.detail).not.toContain("hello"); // note content never recorded
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records an entry for deleteFolder with the doc count", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-diag-"));
    try {
      const { engine, docStore } = await newEngineWithThreeNotes(root);
      const folderId = engine.createFolder(undefined, "Notes");
      await engine.persistTree();
      await engine.deleteFolder(folderId);

      const entries = await readDiagnostics(docStore);
      const entry = entries.find((e) => e.op === "delete-folder");
      expect(entry).toBeDefined();
      expect(entry!.counts?.docs).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records refuse-empty-scan when ingest hits the empty-scan safety rail", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-diag-"));
    try {
      const { engine, docStore } = await newEngineWithThreeNotes(root);
      const realList = engine.docStore.listMaterializedPaths.bind(engine.docStore);
      let calls = 0;
      engine.docStore.listMaterializedPaths = async () => {
        calls++;
        return calls === 1 ? [] : await realList();
      };

      await engine.ingestExternalChanges();

      const entries = await readDiagnostics(docStore);
      expect(entries.some((e) => e.op === "refuse-empty-scan")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records refuse-mass-deletion when ingest hits the mass-deletion safety rail", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-diag-"));
    try {
      const { engine, docStore } = await newEngineWithThreeNotes(root);
      await docStore.removeMaterialized("welcome.md");
      await docStore.removeMaterialized("Untitled.md");

      await engine.ingestExternalChanges();

      const entries = await readDiagnostics(docStore);
      expect(entries.some((e) => e.op === "refuse-mass-deletion")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records refuse-reserved-path-write when a materialize call targets .methyl/", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-diag-"));
    try {
      const { engine, docStore, ids } = await newEngineWithThreeNotes(root);
      await engine.materializeDocument(ids[0]!, ".methyl/crdt/docs/should-not-write.md");

      const entries = await readDiagnostics(docStore);
      expect(entries.some((e) => e.op === "refuse-reserved-path-write")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records legacy-id-migration on VaultEngine.open() when a doc carries a legacy id comment", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-diag-"));
    try {
      const treeStore = new NodeVaultTreeStore(root);
      const docStore = new NodeFSStore(root);
      const engine = await VaultEngine.create(treeStore, docStore);
      const doc = engine.createDocument(undefined, "welcome.md", "hello");
      // Simulate a pre-sidecar-index vault: legacy id comment persisted
      // inside the LoroText itself (fromMarkdown normally strips it).
      doc.getText(CONTENT_KEY).insert(0, `<!-- adhd:id=${doc.id} -->\n\n`);
      doc.doc.commit();
      await engine.persistTree();
      await engine.persistDocumentIncremental(doc.id);

      await VaultEngine.open(treeStore, docStore);

      const entries = await readDiagnostics(docStore);
      expect(entries.some((e) => e.op === "legacy-id-migration")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps the ring buffer at ~100 entries, dropping the oldest first", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-diag-"));
    try {
      const docStore = new NodeFSStore(root);
      for (let i = 0; i < 120; i++) {
        await recordDiagnostic(docStore, `op-${i}`);
      }
      const entries = await readDiagnostics(docStore);
      expect(entries.length).toBe(100);
      expect(entries[0]!.op).toBe("op-20");
      expect(entries.at(-1)!.op).toBe("op-119");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a failing diagnostics write never throws and never breaks the caller", async () => {
    const root = mkdtempSync(join(tmpdir(), "adhd-diag-"));
    try {
      const docStore = new NodeFSStore(root);
      const original = docStore.writeMaterializedAtomic.bind(docStore);
      docStore.writeMaterializedAtomic = async () => {
        throw new Error("disk full");
      };
      await expect(recordDiagnostic(docStore, "delete-document")).resolves.toBeUndefined();
      docStore.writeMaterializedAtomic = original;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
