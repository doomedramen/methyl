import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { ensureInbox, captureToInbox } from "@/lib/vault/inbox";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-inbox-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function newEngine(): Promise<VaultEngine> {
  const treeStore = new NodeVaultTreeStore(tmpDir);
  const docStore = new NodeFSStore(tmpDir);
  return VaultEngine.create(treeStore, docStore);
}

describe("ensureInbox", () => {
  it("creates a top-level Inbox folder when none exists", async () => {
    const engine = await newEngine();
    const id = ensureInbox(engine);
    const node = engine.tree.getNode(id);
    expect(node?.kind).toBe("directory");
    expect(node?.name).toBe("Inbox");
    expect(engine.tree.roots().some((n) => n.treeId === id)).toBe(true);
  });

  it("reuses an existing Inbox folder rather than duplicating it", async () => {
    const engine = await newEngine();
    const first = ensureInbox(engine);
    const second = ensureInbox(engine);
    expect(second).toBe(first);
    expect(engine.tree.roots().filter((n) => n.kind === "directory")).toHaveLength(1);
  });

  it("matches an existing folder case-insensitively", async () => {
    const engine = await newEngine();
    const existing = engine.createFolder(undefined, "inbox");
    const found = ensureInbox(engine);
    expect(found).toBe(existing);
  });
});

describe("captureToInbox", () => {
  it("creates the note inside the Inbox folder", async () => {
    const engine = await newEngine();
    const doc = await captureToInbox(engine, "Shared note.md", "# hello");
    const node = engine.tree.findByDocumentId(doc.id);
    const inbox = ensureInbox(engine);
    expect(node?.name).toBe("Shared note.md");
    const parentChildren = engine.tree.children(inbox).map((c) => c.documentId);
    expect(parentChildren).toContain(doc.id);
  });

  it("auto-suffixes on a name clash within Inbox", async () => {
    const engine = await newEngine();
    await captureToInbox(engine, "Untitled.md", "# one");
    const second = await captureToInbox(engine, "Untitled.md", "# two");
    const node = engine.tree.findByDocumentId(second.id);
    expect(node?.name).toBe("Untitled 2.md");
  });
});
