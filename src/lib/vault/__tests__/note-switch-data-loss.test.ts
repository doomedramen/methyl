import { describe, it, expect } from "vitest";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import type { VaultFileSystem } from "@/lib/vault/fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";
import { createEditorSession } from "@/lib/editor/session";

/**
 * Wraps MemoryVaultFS with real async latency on every op, standing in for
 * "OPFS-like" I/O timing (real OPFS access-handle writes are not
 * instantaneous the way an in-memory Map is) — needed to open the same
 * race windows the reported bug depends on.
 */
class SlowVaultFS implements VaultFileSystem {
  constructor(
    private inner: VaultFileSystem,
    private delayMs: number,
  ) {}
  private async delay<T>(v: T): Promise<T> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return v;
  }
  readFile(path: string) {
    return this.inner.readFile(path).then((v) => this.delay(v));
  }
  readTextFile(path: string) {
    return this.inner.readTextFile(path).then((v) => this.delay(v));
  }
  async writeFile(path: string, data: Uint8Array) {
    await this.delay(null);
    return this.inner.writeFile(path, data);
  }
  async writeTextAtomic(path: string, text: string) {
    await this.delay(null);
    return this.inner.writeTextAtomic(path, text);
  }
  async mkdir(path: string) {
    await this.delay(null);
    return this.inner.mkdir(path);
  }
  async delete(path: string) {
    await this.delay(null);
    return this.inner.delete(path);
  }
  exists(path: string) {
    return this.inner.exists(path).then((v) => this.delay(v));
  }
  readdir(path: string) {
    return this.inner.readdir(path).then((v) => this.delay(v));
  }
  walk() {
    return this.inner.walk();
  }
}

/**
 * Reproduces the reported UI sequence (create note -> type -> switch to
 * next note -> ... -> reload) using the exact same primitives the app
 * uses: VaultApp.onCreateNote's unawaited persist calls
 * (src/components/vault/VaultApp.tsx:153-155) and NoteEditor's session
 * lifecycle (src/lib/editor/session.ts, src/components/editor/NoteEditor.tsx).
 *
 * Key suspect reproduced here: NoteEditor's cleanup on unmount
 * (src/components/editor/NoteEditor.tsx:109-114) calls
 * `session.dispose(true).then(...)` but the surrounding useEffect cleanup
 * function is synchronous — React never awaits it. Switching notes fires
 * this cleanup and immediately proceeds to create/open the next note
 * without waiting for the previous note's flush to land.
 */

async function newEngine(delayMs = 0) {
  const raw = new MemoryVaultFS();
  const fs: VaultFileSystem = delayMs > 0 ? new SlowVaultFS(raw, delayMs) : raw;
  const treeStore = new OpfsVaultTreeStore(fs);
  const docStore = new OpfsDocStore(fs);
  const engine = await VaultEngine.create(treeStore, docStore, "local");
  return { engine, fs, raw };
}

/** Mirrors VaultApp.onCreateNote (fire-and-forget persists, not awaited). */
function createNoteLikeApp(engine: VaultEngine, name: string) {
  const doc = engine.createDocument(undefined, name, "");
  void engine.persistTreeIncremental();
  void engine.persistDocumentIncremental(doc.id);
  return doc;
}

/** Mirrors NoteEditor: open a session, type, and "switch away" without awaiting dispose. */
function openTypeAndSwitchAway(
  engine: VaultEngine,
  documentId: string,
  body: string,
  maxDirtyMs: number,
) {
  const session = createEditorSession({ engine, documentId, maxDirtyMs });
  const text = session.text;
  text.insert(text.length, body);
  session.doc.commit();
  session.schedulePersist();
  // NoteEditor.tsx:113 — fire-and-forget, exactly as production code does.
  void session.dispose(true);
}

describe("note-switch data loss (reported: Untitled.md / Untitled 2.md end up empty)", () => {
  it("typed content in a note survives creating and switching to the next note immediately, then a reload", async () => {
    const { engine, fs } = await newEngine();

    const docA = createNoteLikeApp(engine, "Untitled.md");
    openTypeAndSwitchAway(engine, docA.id, "alpha body", 50);

    const docB = createNoteLikeApp(engine, "Untitled 2.md");
    openTypeAndSwitchAway(engine, docB.id, "beta body", 50);

    const docC = createNoteLikeApp(engine, "Untitled 3.md");
    openTypeAndSwitchAway(engine, docC.id, "gamma body", 50);

    // Give every fire-and-forget promise a chance to settle — real usage
    // has seconds between actions (the report describes a 4.5s wait per
    // note); this only needs to be longer than persistDebounceMs/maxDirtyMs.
    await new Promise((r) => setTimeout(r, 500));

    // "Reload tab 1": a fresh VaultEngine loading from the same stores.
    const treeStore2 = new OpfsVaultTreeStore(fs);
    const docStore2 = new OpfsDocStore(fs);
    const { engine: reopened } = await VaultEngine.open(treeStore2, docStore2, "local");
    await reopened.reconcileMaterialization();

    const a = reopened.getDocument(docA.id);
    const b = reopened.getDocument(docB.id);
    const c = reopened.getDocument(docC.id);

    expect(a?.getText(CONTENT_KEY).toString()).toBe("alpha body");
    expect(b?.getText(CONTENT_KEY).toString()).toBe("beta body");
    expect(c?.getText(CONTENT_KEY).toString()).toBe("gamma body");

    expect(await fs.readTextFile("Untitled.md")).toBe("alpha body");
    expect(await fs.readTextFile("Untitled 2.md")).toBe("beta body");
    expect(await fs.readTextFile("Untitled 3.md")).toBe("gamma body");
  });

  it("with OPFS-like I/O latency: create-time and edit-time persists for the same doc race", async () => {
    const { engine, fs } = await newEngine(15);
    const maxDirtyMs = 100;

    const docA = createNoteLikeApp(engine, "Untitled.md");
    openTypeAndSwitchAway(engine, docA.id, "alpha body", maxDirtyMs);

    const docB = createNoteLikeApp(engine, "Untitled 2.md");
    openTypeAndSwitchAway(engine, docB.id, "beta body", maxDirtyMs);

    const docC = createNoteLikeApp(engine, "Untitled 3.md");
    openTypeAndSwitchAway(engine, docC.id, "gamma body", maxDirtyMs);

    // Real usage waits far longer than any timer here (the report: 4.5s
    // per note vs. a 400ms debounce / a few-second max-dirty) before
    // switching, so give every in-flight write generous time to settle —
    // this test is about write ORDERING, not running out of time.
    await new Promise((r) => setTimeout(r, 3000));

    const treeStore2 = new OpfsVaultTreeStore(fs);
    const docStore2 = new OpfsDocStore(fs);
    const { engine: reopened } = await VaultEngine.open(treeStore2, docStore2, "local");
    await reopened.reconcileMaterialization();

    const a = reopened.getDocument(docA.id);
    const b = reopened.getDocument(docB.id);
    const c = reopened.getDocument(docC.id);

    expect(a?.getText(CONTENT_KEY).toString()).toBe("alpha body");
    expect(b?.getText(CONTENT_KEY).toString()).toBe("beta body");
    expect(c?.getText(CONTENT_KEY).toString()).toBe("gamma body");
  }, 15000);

  it("full reported sequence: create x3 + type, create folder, move a note, reload tab 1, open tab 2 concurrently", async () => {
    const { engine, fs } = await newEngine(15);
    const maxDirtyMs = 100;

    const docA = createNoteLikeApp(engine, "Untitled.md");
    openTypeAndSwitchAway(engine, docA.id, "alpha body", maxDirtyMs);
    const docB = createNoteLikeApp(engine, "Untitled 2.md");
    openTypeAndSwitchAway(engine, docB.id, "beta body", maxDirtyMs);
    const docC = createNoteLikeApp(engine, "Untitled 3.md");
    openTypeAndSwitchAway(engine, docC.id, "gamma body", maxDirtyMs);

    // Create "Projects" and move Untitled 2 to root position (matches the
    // report: "ended up reordered after Projects at root, not inside") —
    // VaultApp.onCreateFolder/AppSidebar's drop handler pattern: fire tree
    // mutation + persistTreeIncremental, unawaited.
    engine.createFolder(undefined, "Projects");
    void engine.persistTreeIncremental();
    const nodeB = engine.tree.findByDocumentId(docB.id)!;
    void engine.moveNode(nodeB.treeId, undefined, 0);

    // "Reload tab 1" — without waiting for the above to settle first,
    // exactly like a real reload can land mid-flight.
    const treeStoreT1 = new OpfsVaultTreeStore(fs);
    const docStoreT1 = new OpfsDocStore(fs);
    const openTab1 = VaultEngine.open(treeStoreT1, docStoreT1, "local").then(
      async ({ engine: e }) => {
        await e.reconcileMaterialization();
        return e;
      },
    );

    // "Opened a second tab" concurrently, reading/reconciling the same
    // on-disk state while tab 1's reload/reconcile is still in flight.
    const treeStoreT2 = new OpfsVaultTreeStore(fs);
    const docStoreT2 = new OpfsDocStore(fs);
    const openTab2 = VaultEngine.open(treeStoreT2, docStoreT2, "local").then(
      async ({ engine: e }) => {
        await e.reconcileMaterialization();
        return e;
      },
    );

    const [tab1, tab2] = await Promise.all([openTab1, openTab2]);
    // Let anything still-pending from the original engine's fire-and-forget
    // calls finish too, then do one more authoritative reopen to check the
    // final settled state on disk.
    await new Promise((r) => setTimeout(r, 500));
    const treeStoreFinal = new OpfsVaultTreeStore(fs);
    const docStoreFinal = new OpfsDocStore(fs);
    const { engine: final } = await VaultEngine.open(treeStoreFinal, docStoreFinal, "local");
    await final.reconcileMaterialization();

    for (const [label, eng] of [
      ["tab1", tab1],
      ["tab2", tab2],
      ["final", final],
    ] as const) {
      expect(eng.getDocument(docA.id)?.getText(CONTENT_KEY).toString(), `${label} docA`).toBe(
        "alpha body",
      );
      expect(eng.getDocument(docB.id)?.getText(CONTENT_KEY).toString(), `${label} docB`).toBe(
        "beta body",
      );
      expect(eng.getDocument(docC.id)?.getText(CONTENT_KEY).toString(), `${label} docC`).toBe(
        "gamma body",
      );
    }
  }, 20000);
});

describe("ingest conflict rule: CRDT wins over a shrinking/emptying external edit with un-materialized newer changes", () => {
  it("keeps un-materialized CRDT content instead of merging a shorter/empty disk file over it", async () => {
    const { engine, fs } = await newEngine();

    const doc = engine.createDocument(undefined, "note.md", "");
    // Materialize the EMPTY state first — this becomes the index's/
    // persisted-state's last-known-good checkpoint (frontiers F0).
    await engine.persistTree();
    await engine.persistDocumentIncremental(doc.id);

    // Now make a local edit WITHOUT re-persisting/re-compacting — this is
    // exactly "the CRDT has un-materialized changes newer than the index
    // entry": frontiers have moved past docStore.readState()'s frontiers,
    // but nothing has re-run compact()/touchIndexEntry() yet.
    const active = engine.getDocument(doc.id)!;
    active.getText(CONTENT_KEY).insert(0, "important unsaved-to-disk text");
    active.doc.commit();

    // Simulate disk showing something OTHER than what's indexed — shorter
    // than the un-materialized CRDT content — whatever the exact mechanism
    // (a truncate-then-slow-write, a scan catching a partial write, etc.).
    await fs.writeFile("note.md", new TextEncoder().encode("x"));

    const report = await engine.ingestExternalChanges();

    // Must NOT have treated this as an accepted edit that replaced content.
    expect(report.edited).not.toContain(doc.id);
    expect(engine.getDocument(doc.id)!.getText(CONTENT_KEY).toString()).toBe(
      "important unsaved-to-disk text",
    );
    // The engine should have re-materialised its own (correct) content
    // over the stale empty file rather than leaving disk wrong.
    expect(await fs.readTextFile("note.md")).toBe("important unsaved-to-disk text");
  });

  it("still accepts a real external edit when the CRDT has no un-materialized changes ahead of the index", async () => {
    const { engine, fs } = await newEngine();

    const doc = engine.createDocument(undefined, "note.md", "original");
    await engine.persistTree();
    await engine.persistDocumentIncremental(doc.id); // fully materialized: frontiers match state

    // A genuine external edit — smaller AND after a real checkpoint.
    await fs.writeFile("note.md", new TextEncoder().encode("orig"));

    const report = await engine.ingestExternalChanges();

    expect(report.edited).toContain(doc.id);
    expect(engine.getDocument(doc.id)!.getText(CONTENT_KEY).toString()).toBe("orig");
  });
});
