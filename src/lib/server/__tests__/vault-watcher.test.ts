import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { FSWatcher } from "chokidar";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { watchVaultForExternalChanges } from "@/lib/server/vault-watcher";

function waitFor(check: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe("watchVaultForExternalChanges (Node fs vault)", () => {
  let tmp: string | undefined;
  let watcher: FSWatcher | undefined;

  afterEach(async () => {
    if (watcher) {
      await watcher.close();
      watcher = undefined;
    }
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("picks up an externally created .md file and ingests it", async () => {
    tmp = mkdtempSync(join(tmpdir(), "adhd-watcher-"));
    const treeStore = new NodeVaultTreeStore(tmp);
    const docStore = new NodeFSStore(tmp);
    const engine = await VaultEngine.create(treeStore, docStore);

    const ingests: number[] = [];
    const roomUpdates: string[] = [];
    watcher = watchVaultForExternalChanges({
      vaultPath: tmp,
      engine,
      debounceMs: 50,
      onIngested: (report) => ingests.push(report.created.length),
      onRoomUpdate: (roomId) => roomUpdates.push(roomId),
    });

    await new Promise((r) => setTimeout(r, 150)); // let the watcher settle

    writeFileSync(join(tmp, "External.md"), "written by another editor");

    // Wait for a full ingest pass to finish (not just the tree mutation
    // partway through it) so the room-update broadcast has happened too.
    await waitFor(() => ingests.length > 0 && engine.tree.documentIds().length > 0);

    const ids = engine.tree.documentIds();
    expect(ids.length).toBe(1);
    expect(engine.getDocument(ids[0]!)!.getMarkdown()).toBe(
      "written by another editor",
    );
    expect(roomUpdates.some((r) => r === `vault:${engine.vaultId}`)).toBe(true);
    expect(roomUpdates.some((r) => r.startsWith("doc:"))).toBe(true);
  }, 10000);

  it("does not re-ingest the app's own materialize write", async () => {
    tmp = mkdtempSync(join(tmpdir(), "adhd-watcher-"));
    const treeStore = new NodeVaultTreeStore(tmp);
    const docStore = new NodeFSStore(tmp);
    const engine = await VaultEngine.create(treeStore, docStore);

    let ingestCount = 0;
    watcher = watchVaultForExternalChanges({
      vaultPath: tmp,
      engine,
      debounceMs: 50,
      onIngested: () => {
        ingestCount++;
      },
    });

    await new Promise((r) => setTimeout(r, 150));

    const doc = engine.createDocument(undefined, "note.md", "hello");
    await engine.persistTree();
    await engine.persistDocumentIncremental(doc.id); // the app's own write

    // Give the watcher a chance to notice the write and run an ingest pass.
    await new Promise((r) => setTimeout(r, 400));

    // The app's own write is indexed as it happens (touchIndexEntry), so
    // even though the watcher fired, ingest found nothing external.
    const stillOneDoc = engine.tree.documentIds();
    expect(stillOneDoc).toEqual([doc.id]);
    expect(engine.getDocument(doc.id)!.getMarkdown()).toBe("hello");
    void ingestCount;
  }, 10000);
});
