import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";
import { createEditorSession } from "@/lib/editor/session";
import { getContentTextFromDoc } from "@/lib/editor/sync";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stripIdComment } from "@/lib/core/doc-id";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-sess-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeEngine() {
  const engine = await VaultEngine.create(
    new NodeVaultTreeStore(tmpDir),
    new NodeFSStore(tmpDir),
  );
  return engine;
}

function body(doc: ReturnType<VaultEngine["getDocument"]>): string {
  return doc
    ? stripIdComment(doc.getText().toString()).replace(/^\n+/, "")
    : "";
}

describe("createEditorSession", () => {
  it("persists on flush and reopens with the exact text", async () => {
    const engine = await makeEngine();
    const doc = engine.createDocument(undefined, "note.md", "# Note\n\nhello");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "Note.md");

    const session = createEditorSession({ engine, documentId: doc.id });
    session.text.splice(session.text.length, 0, " world");
    session.schedulePersist();
    expect(session.isDirty()).toBe(true);

    await session.dispose(true);

    // Reopen from store
    const reopened = await VaultEngine.open(
      new NodeVaultTreeStore(tmpDir),
      new NodeFSStore(tmpDir),
    );
    const reopenedDoc = reopened.engine.getDocument(doc.id);
    expect(body(reopenedDoc)).toBe("# Note\n\nhello world");
  });

  it("flush is idempotent when clean", async () => {
    const engine = await makeEngine();
    const doc = engine.createDocument(undefined, "a.md", "# A");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "A.md");

    const session = createEditorSession({ engine, documentId: doc.id });
    session.schedulePersist();
    await session.flush();
    await session.flush();
    expect(session.isDirty()).toBe(false);
    expect(session.lastPersistedAt()).not.toBeNull();
    await session.dispose();
  });

  it("onPersisted fires once after a flush with pending edits", async () => {
    const engine = await makeEngine();
    const doc = engine.createDocument(undefined, "b.md", "# B");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "B.md");

    let persisted = 0;
    const session = createEditorSession({
      engine,
      documentId: doc.id,
      onPersisted: () => persisted++,
    });
    const text = session.text;
    text.splice(text.length, 0, "\n\nupdated in editor");
    session.schedulePersist();
    await session.flush();
    expect(persisted).toBe(1);
    await session.dispose();

    const reopened = await VaultEngine.open(
      new NodeVaultTreeStore(tmpDir),
      new NodeFSStore(tmpDir),
    );
    expect(body(reopened.engine.getDocument(doc.id))).toContain(
      "updated in editor",
    );
  });

  it("throws when the doc is not loaded in the engine", async () => {
    const engine = await makeEngine();
    expect(() => createEditorSession({ engine, documentId: "nope" })).toThrow(
      /not open in engine/,
    );
  });

  it("dispose without flush leaves edits dirty and unpersisted", async () => {
    const engine = await makeEngine();
    const doc = engine.createDocument(undefined, "c.md", "# C");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "C.md");

    const session = createEditorSession({ engine, documentId: doc.id });
    session.text.splice(session.text.length, 0, " draft");
    session.schedulePersist();
    await session.dispose(false);

    const reopened = await VaultEngine.open(
      new NodeVaultTreeStore(tmpDir),
      new NodeFSStore(tmpDir),
    );
    expect(body(reopened.engine.getDocument(doc.id))).toBe("# C");
  });

  it("two sessions on the same doc agree on text via a shared LoroDoc", async () => {
    const engine = await makeEngine();
    const doc = engine.createDocument(undefined, "d.md", "# D");
    await engine.persistTree();
    await engine.materializeDocument(doc.id, "D.md");

    const sA = createEditorSession({ engine, documentId: doc.id });
    const sB = createEditorSession({ engine, documentId: doc.id });

    sA.text.splice(0, 1, "## D");
    sA.schedulePersist();
    // Both sessions wrap the same underlying LoroDoc (engine-owned)
    expect(getContentTextFromDoc(sB.doc).toString()).toBe(
      getContentTextFromDoc(sA.doc).toString(),
    );
    await sA.dispose();
    await sB.dispose();
  });
});