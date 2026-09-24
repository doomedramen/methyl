import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("vault delete guards", () => {
  it("refuses to delete the vault root or the reserved metadata directories", async () => {
    const fs = new MemoryVaultFS();
    await fs.writeFile(".methyl/crdt/docs/a/snapshot.loro", bytes("x"));
    for (const path of ["", "/", ".methyl", ".methyl/", ".methyl/crdt", ".methyl/crdt/docs", ".methyl/crdt/vault", "a/../.methyl"]) {
      await expect(fs.delete(path, { recursive: true }), path).rejects.toThrow(/protected/);
    }
    expect(await fs.exists(".methyl/crdt/docs/a/snapshot.loro")).toBe(true);
  });

  it("only removes a non-empty directory when asked to recurse", async () => {
    const fs = new MemoryVaultFS();
    await fs.writeFile("Notes/a.md", bytes("a"));
    await fs.writeFile("Notes/b.md", bytes("b"));
    await expect(fs.delete("Notes")).rejects.toThrow(/non-empty/);
    expect(await fs.exists("Notes/a.md")).toBe(true);
    await fs.delete("Notes/a.md");
    expect(await fs.exists("Notes/a.md")).toBe(false);
    await fs.delete("Notes", { recursive: true });
    expect(await fs.exists("Notes/b.md")).toBe(false);
  });

  it("compaction still clears superseded update segments", async () => {
    const fs = new MemoryVaultFS();
    const docs = new OpfsDocStore(fs);
    await docs.appendUpdate("d1", bytes("u1"));
    await docs.appendUpdate("d1", bytes("u2"));
    await docs.compact("d1", bytes("snap"), {
      documentId: "d1",
      frontiers: [],
      sha256: "",
      compactedAt: 0,
      lastUpdateAt: 0,
      segments: 0,
      updateBytes: 0,
    });
    expect(await docs.loadUpdates("d1")).toEqual([]);
    expect(await docs.loadSnapshot("d1")).toEqual(bytes("snap"));

    const tree = new OpfsVaultTreeStore(fs);
    await tree.appendUpdate(bytes("t1"));
    await tree.compact(bytes("tree"), { frontiers: [], compactedAt: 0, lastUpdateAt: 0, segments: 0, updateBytes: 0 });
    expect(await tree.loadUpdates()).toEqual([]);
  });

  it("raw remove APIs appear only in the two store modules", () => {
    const root = join(__dirname, "..", "..", "..");
    const allowed = new Set(["lib/vault/opfs.ts", "lib/server/fs-store.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "__tests__" && name !== "node_modules") walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(name)) continue;
        const rel = relative(root, full);
        if (allowed.has(rel)) continue;
        const src = readFileSync(full, "utf8");
        if (/\.removeEntry\(|\bfs\.rm\(|\bfs\.rmdir\(|\bunlinkSync\(|\brmSync\(/.test(src)) offenders.push(rel);
      }
    };
    walk(root);
    // sync-server.ts unlinks its own upload temp files and replaced asset
    // copies under .methyl/server/assets — never vault content.
    expect(offenders.filter((f) => f !== "lib/server/sync-server.ts")).toEqual([]);
  });
});
