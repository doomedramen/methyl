import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { Document, CONTENT_KEY } from "@/lib/core/document";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-legacy-migration-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Document.migrateLegacyIdComment", () => {
  it("deletes the comment as a real CRDT text edit and is idempotent", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const doc = new Document(id);
    // Bypass fromMarkdown's own stripping to simulate an *already persisted*
    // legacy LoroText, as if it had been written before the sidecar index
    // existed.
    doc.getText(CONTENT_KEY).insert(
      0,
      `<!-- adhd:id=${id} -->\n\n# Welcome\n\nHello`,
    );
    doc.doc.commit();

    expect(doc.getMarkdown()).toContain("adhd:id");

    const migrated = doc.migrateLegacyIdComment();
    expect(migrated).toBe(true);
    expect(doc.getMarkdown()).not.toContain("adhd:id");
    expect(doc.getMarkdown()).toBe("# Welcome\n\nHello");

    // Idempotent: nothing left to strip.
    expect(doc.migrateLegacyIdComment()).toBe(false);
  });
});

describe("VaultEngine.open — legacy vault migration", () => {
  it("strips a legacy adhd:id comment found in previously-persisted LoroText on open", async () => {
    // 1. Build a vault the "old" way: a doc whose LoroText still carries
    //    the legacy comment, as if seeded/edited before the sidecar index
    //    existed (e.g. an existing OPFS "Welcome" note).
    const treeStore = new NodeVaultTreeStore(tmpDir);
    const docStore = new NodeFSStore(tmpDir);
    const engine = await VaultEngine.create(treeStore, docStore);

    const doc = engine.createDocument(
      undefined,
      "Welcome.md",
      "# Welcome\n\nHello from before the sidecar index",
    );
    const docId = doc.id;
    // Simulate a pre-sidecar-index vault: the legacy comment ended up
    // inside the persisted LoroText itself (as `insertIdComment` used to
    // do), not just in a raw file on disk.
    doc.getText(CONTENT_KEY).insert(0, `<!-- adhd:id=${docId} -->\n\n`);
    doc.doc.commit();
    await engine.persistTree();
    await engine.persistDocumentIncremental(docId);
    await engine.materializeDocument(docId, join(tmpDir, "Welcome.md"));

    // Sanity: legacy comment really did make it to disk, as an existing
    // vault would have it.
    expect(doc.getMarkdown()).toContain("adhd:id");

    // 2. Reopen — this is the hydrate path that must migrate in place.
    const { engine: reopened, recovery } = await VaultEngine.open(
      treeStore,
      docStore,
    );

    expect(recovery.migratedLegacyIds).toContain(docId);
    const reopenedDoc = reopened.getDocument(docId)!;
    expect(reopenedDoc.getMarkdown()).not.toContain("adhd:id");
    expect(reopenedDoc.getMarkdown()).toBe(
      "# Welcome\n\nHello from before the sidecar index",
    );

    // 3. The migration must be a durable, syncable CRDT edit — not just an
    //    in-memory patch — so a third open (fresh load from disk) sees the
    //    already-clean content and reports nothing left to migrate.
    const { engine: thirdOpen, recovery: recovery2 } = await VaultEngine.open(
      treeStore,
      docStore,
    );
    expect(recovery2.migratedLegacyIds).toEqual([]);
    expect(thirdOpen.getDocument(docId)!.getMarkdown()).not.toContain("adhd:id");

    // 4. materializeDocument must write getMarkdown() unchanged — no
    //    reinsertion of any id marker.
    await reopened.materializeDocument(docId, join(tmpDir, "Welcome.md"));
    const bytes = await docStore.readMaterialized(join(tmpDir, "Welcome.md"));
    const onDisk = new TextDecoder().decode(bytes!);
    expect(onDisk).not.toContain("adhd:id");
    expect(onDisk).toBe(reopenedDoc.getMarkdown());
  });
});
