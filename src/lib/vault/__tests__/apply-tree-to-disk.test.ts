import { describe, expect, it } from "vitest";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";

async function engineOn(fs: MemoryVaultFS) {
  return VaultEngine.create(new OpfsVaultTreeStore(fs), new OpfsDocStore(fs), "local");
}

/** Local vault with two notes, plus a peer that has pulled its tree. */
async function setup() {
  const fs = new MemoryVaultFS();
  const local = await engineOn(fs);
  const keep = local.createDocument(undefined, "keep.md", "keep\n");
  const gone = local.createDocument(undefined, "gone.md", "gone\n");
  await local.persistTree();
  await local.persistDocumentIncremental(keep.id);
  await local.persistDocumentIncremental(gone.id);
  const peer = await engineOn(new MemoryVaultFS());
  peer.tree.doc.import(local.tree.doc.export({ mode: "snapshot" }));
  return { fs, local, peer, keep, gone };
}

function pullFromPeer(local: VaultEngine, peer: VaultEngine) {
  peer.tree.doc.commit();
  local.tree.doc.import(peer.tree.doc.export({ mode: "snapshot" }));
}

describe("applyTreeToDisk after a sync merge", () => {
  it("removes the file of a note deleted on another device", async () => {
    const { fs, local, peer, gone } = await setup();
    peer.tree.delete(peer.tree.findByDocumentId(gone.id)!.treeId);
    pullFromPeer(local, peer);

    const { removed } = await local.applyTreeToDisk();

    expect(removed).toEqual(["gone.md"]);
    expect(await fs.exists("gone.md")).toBe(false);
    expect(await fs.readTextFile("keep.md")).toBe("keep\n");
  });

  it("moves the file of a note renamed or moved on another device", async () => {
    const { fs, local, peer, keep } = await setup();
    const folder = peer.createFolder(undefined, "Archive");
    const node = peer.tree.findByDocumentId(keep.id)!;
    peer.tree.move(node.treeId, folder);
    peer.tree.rename(node.treeId, "kept.md");
    pullFromPeer(local, peer);

    const { moved } = await local.applyTreeToDisk();

    expect(moved).toEqual(["Archive/kept.md"]);
    expect(await fs.exists("keep.md")).toBe(false);
    expect(await fs.readTextFile("Archive/kept.md")).toBe("keep\n");
  });

  it("leaves a file alone while it holds an external edit not yet ingested", async () => {
    const { fs, local, peer, gone } = await setup();
    await fs.writeFile("gone.md", new TextEncoder().encode("gone\nedited outside\n"));
    peer.tree.delete(peer.tree.findByDocumentId(gone.id)!.treeId);
    pullFromPeer(local, peer);

    const { removed } = await local.applyTreeToDisk();

    expect(removed).toEqual([]);
    expect(await fs.readTextFile("gone.md")).toBe("gone\nedited outside\n");
  });
});
