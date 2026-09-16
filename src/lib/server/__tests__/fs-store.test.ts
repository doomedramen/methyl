import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";
import { stripIdComment } from "@/lib/core/doc-id";
import { SEGMENT_RE, shouldCompact } from "@/lib/vault/compact";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-fs-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function newTreeStore(): NodeVaultTreeStore {
  return new NodeVaultTreeStore(tmpDir);
}

function newDocStore(): NodeFSStore {
  return new NodeFSStore(tmpDir);
}

function crdtDocDir(docId: string): string {
  return join(tmpDir, ".adhd/crdt/docs", docId);
}

/** Body without the adhd:id marker comment (§5). */
function bodyOf(docText: string): string {
  return stripIdComment(docText).replace(/^\n/, "").trimStart();
}

describe("NodeFSStore persistence (§10)", () => {
  it("reopens a document from a binary snapshot (P1 crash-recovery)", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);

    const doc = engine.createDocument(
      undefined,
      "note.md",
      "# Note\n\nOriginal body",
    );
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "Note.md");

    const { engine: reopened } = await VaultEngine.open(treeStore, docStore);
    const reopenedDoc = reopened.getDocument(doc.id);
    expect(reopenedDoc).toBeDefined();
    expect(bodyOf(reopenedDoc!.getText(CONTENT_KEY).toString())).toBe(
      "# Note\n\nOriginal body",
    );
  });

  it("recovers a document from snapshot + incremental updates", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);

    const doc = engine.createDocument(undefined, "a.md", "# A\n\nv1");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "A.md");

    doc.getText(CONTENT_KEY).splice(doc.getText(CONTENT_KEY).length, 0, "\nv2");
    await engine.persistDocumentIncremental(doc.id);

    doc.getText(CONTENT_KEY).splice(doc.getText(CONTENT_KEY).length, 0, "\nv3");
    await engine.persistDocumentIncremental(doc.id);

    const state = await docStore.readState(doc.id);
    expect(state!.segments).toBe(2);

    const { engine: reopened } = await VaultEngine.open(treeStore, docStore);
    const reopenedDoc = reopened.getDocument(doc.id);
    expect(bodyOf(reopenedDoc!.getText(CONTENT_KEY).toString())).toBe(
      "# A\n\nv1\nv2\nv3",
    );
  });

  it("compaction rewrites snapshot and clears update segments", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);

    const doc = engine.createDocument(undefined, "c.md", "# C\n\nseed");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "C.md");

    // Compact every 10 segments for a fast deterministic test
    const rules = {
      maxSegments: 10,
      maxBytes: 1024 * 1024,
      maxAgeMs: 24 * 60 * 60 * 1000,
    };

    for (let i = 0; i < 13; i++) {
      doc.getText(CONTENT_KEY).splice(doc.getText(CONTENT_KEY).length, 0, ` ${i}`);
      await engine.persistDocumentIncremental(doc.id, rules);
    }

    const post = await docStore.readState(doc.id);
    expect(post!.segments).toBe(3); // 13 appended − 10 compacted

    const updatesDir = join(crdtDocDir(doc.id), "updates");
    expect(readdirSync(updatesDir).filter((f) => SEGMENT_RE.test(f))).toHaveLength(3);
    expect(existsSync(join(crdtDocDir(doc.id), "snapshot.loro"))).toBe(true);

    const state = await docStore.readState(doc.id);
    expect(state!.segments).toBe(3);
    expect(shouldCompact(state!, undefined, rules)).toBe(false);

    const { engine: reopened } = await VaultEngine.open(treeStore, docStore);
    const reopenedDoc = reopened.getDocument(doc.id);
    expect(reopenedDoc!.getText(CONTENT_KEY).toString()).toBe(
      doc.getText(CONTENT_KEY).toString(),
    );
  });

  it("compaction runs because of the update-byte threshold", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);

    const doc = engine.createDocument(undefined, "big.md", "# Big\n\npad");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "Big.md");

    // Sub-threshold append: no compaction
    doc.getText(CONTENT_KEY).splice(doc.getText(CONTENT_KEY).length, 0, "\nsmall");
    const r1 = await engine.persistDocumentIncremental(doc.id);
    expect(r1.compacted).toBe(false);
    let state = await docStore.readState(doc.id);
    expect(state!.segments).toBe(1);

    // Oversize append: crosses 1 MiB → immediately compacted
    const blob = "x".repeat(1024 * 1024 + 16);
    doc.getText(CONTENT_KEY).splice(doc.getText(CONTENT_KEY).length, 0, "\n" + blob);
    const r2 = await engine.persistDocumentIncremental(doc.id);
    expect(r2.compacted).toBe(true);

    state = await docStore.readState(doc.id);
    expect(state!.segments).toBe(0);
    expect(state!.updateBytes).toBe(0);
  });

  it("listDocumentIds matches tree-derived active ids", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);
    engine.createDocument(undefined, "x.md", "# X\n\n1");
    engine.createDocument(undefined, "y.md", "# Y\n\n2");
    await engine.persistTree();
    await engine.materializeAll("/");

    const { engine: reopened, recovery } = await VaultEngine.open(treeStore, docStore);
    expect(recovery.activeIds.sort()).toEqual(
      reopened.listDocuments().map((d) => d.id).sort(),
    );
    expect(recovery.missingDocs).toHaveLength(0);
    expect(recovery.orphanedDocs).toHaveLength(0);
  });
});

describe("Materialisation repair (§11, §42)", () => {
  it("detects stale Markdown and repairs from CRDT", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);

    const doc = engine.createDocument(undefined, "stale.md", "# Stale\n\nv1");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "Stale.md");

    doc.getText(CONTENT_KEY).splice(doc.getText(CONTENT_KEY).length, 0, "\nv2-crdt");
    doc.doc.commit();

    expect(await engine.isStale(doc.id, "Stale.md")).toBe(true);

    const cp = await engine.repairDocument(doc.id, "Stale.md");
    expect(cp).not.toBeNull();

    expect(await engine.isStale(doc.id, "Stale.md")).toBe(false);
    const onDisk = readFileSync(join(tmpDir, "Stale.md"), "utf-8");
    expect(onDisk).toContain("v2-crdt");
  });

  it("repairs a missing materialised file", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);
    const doc = engine.createDocument(undefined, "gone.md", "# Gone\n\ncontent");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "Gone.md");

    rmSync(join(tmpDir, "Gone.md"), { force: true });
    expect(await engine.isStale(doc.id, "Gone.md")).toBe(true);
    await engine.repairDocument(doc.id, "Gone.md");
    expect(existsSync(join(tmpDir, "Gone.md"))).toBe(true);
  });
});

describe("Interrupted compaction recovery", () => {
  it("discards leftover .tmp from a crashed compact", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);
    const doc = engine.createDocument(undefined, "crash.md", "# Crash\n\nstable");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "Crash.md");

    const dir = crdtDocDir(doc.id);
    const fs = await import("fs/promises");
    await fs.writeFile(join(dir, "snapshot.loro.tmp"), new Uint8Array([1, 2, 3]));
    await fs.writeFile(join(dir, "state.json.tmp"), JSON.stringify({ partial: 1 }));

    const { engine: reopened } = await VaultEngine.open(treeStore, docStore);
    const reopenedDoc = reopened.getDocument(doc.id);
    expect(bodyOf(reopenedDoc!.getText(CONTENT_KEY).toString())).toBe("# Crash\n\nstable");
    expect(existsSync(join(dir, "snapshot.loro.tmp"))).toBe(false);
    expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
  });

  it("keeps superseded updates after a crash between renames and remove", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);
    const doc = engine.createDocument(undefined, "mid.md", "# Mid\n\nv0");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "Mid.md");
    doc.getText(CONTENT_KEY).splice(doc.getText(CONTENT_KEY).length, 0, "\nv1");
    await engine.persistDocumentIncremental(doc.id);

    const dir = crdtDocDir(doc.id);
    const updatesDir = join(dir, "updates");
    const files = readdirSync(updatesDir).filter((f) => SEGMENT_RE.test(f));
    expect(files.length).toBeGreaterThan(0);

    const { engine: reopened } = await VaultEngine.open(treeStore, docStore);
    const reopenedDoc = reopened.getDocument(doc.id);
    expect(reopenedDoc!.getText(CONTENT_KEY).toString()).toContain("v1");

    const fs = await import("fs/promises");
    await fs.writeFile(join(dir, "snapshot.loro.tmp"), new Uint8Array([9]));
    const { engine: reopened2 } = await VaultEngine.open(treeStore, docStore);
    expect(reopened2.getDocument(doc.id)!.getText(CONTENT_KEY).toString()).toContain("v1");
  });
});

describe("Recovery diff (§42)", () => {
  it("reports retained orphan CRDT dirs without resurrecting them", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);
    const doc = engine.createDocument(undefined, "del.md", "# Del\n\nbye");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "Del.md");

    const treeId = engine.tree.findByName("del.md")![0].treeId;
    engine.tree.delete(treeId);
    await engine.persistTree();

    const { recovery } = await VaultEngine.open(treeStore, docStore);
    expect(recovery.activeIds).not.toContain(doc.id);
    expect(recovery.persistedIds).toContain(doc.id);
    expect(recovery.orphanedDocs).toContain(doc.id);
    expect(recovery.missingDocs).toHaveLength(0);
  });

  it("flags missing CRDT state for tree-listed docs", async () => {
    const docStore = newDocStore();
    const treeStore = newTreeStore();
    const engine = await VaultEngine.create(treeStore, docStore);
    engine.createDocument(undefined, "needs.md", "# Needs\n\nrecover");
    await engine.persistTree();

    const { recovery } = await VaultEngine.open(treeStore, docStore);
    expect(recovery.activeIds).toHaveLength(1);
    expect(recovery.persistedIds).toHaveLength(0);
    expect(recovery.missingDocs).toHaveLength(1);
  });
});