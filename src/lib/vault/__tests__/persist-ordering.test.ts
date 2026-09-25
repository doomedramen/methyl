import { describe, expect, it } from "vitest";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";
import type { VaultFileSystem } from "@/lib/vault/fs";

/** A file system whose every call takes a few milliseconds, like OPFS. */
function slow(inner: VaultFileSystem): VaultFileSystem {
  const wait = () => new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * 4)));
  return {
    readFile: async (p) => (await wait(), inner.readFile(p)),
    readTextFile: async (p) => (await wait(), inner.readTextFile(p)),
    writeFile: async (p, d) => (await wait(), inner.writeFile(p, d)),
    writeTextAtomic: async (p, t) => (await wait(), inner.writeTextAtomic(p, t)),
    mkdir: async (p) => (await wait(), inner.mkdir(p)),
    delete: async (p, o) => (await wait(), inner.delete(p, o)),
    exists: async (p) => (await wait(), inner.exists(p)),
    readdir: async (p) => (await wait(), inner.readdir(p)),
    walk: () => inner.walk(),
  };
}

const ALWAYS_COMPACT = { maxSegments: 1, maxBytes: 1, maxAgeMs: 0 };

describe("overlapping persists of one document", () => {
  it("never lose an edit to a concurrent compaction", async () => {
    for (let round = 0; round < 10; round++) {
      const mem = new MemoryVaultFS();
      const fs = slow(mem);
      const engine = await VaultEngine.create(new OpfsVaultTreeStore(fs), new OpfsDocStore(fs), "local");
      const doc = engine.createDocument(undefined, "note.md", "");
      await engine.persistTree();
      await engine.persistDocumentIncremental(doc.id);

      const text = doc.getText(CONTENT_KEY);
      const persists: Promise<unknown>[] = [];
      for (let i = 0; i < 5; i++) {
        text.insert(text.length, `edit ${i}\n`);
        doc.doc.commit();
        // Fired without waiting, as editor flushes and sync persists are.
        persists.push(engine.persistDocumentIncremental(doc.id, ALWAYS_COMPACT));
      }
      await Promise.all(persists);

      const { engine: reopened } = await VaultEngine.open(
        new OpfsVaultTreeStore(mem),
        new OpfsDocStore(mem),
        "local",
      );
      expect(reopened.getDocument(doc.id)?.getText(CONTENT_KEY).toString()).toBe(
        "edit 0\nedit 1\nedit 2\nedit 3\nedit 4\n",
      );
    }
  });
});
