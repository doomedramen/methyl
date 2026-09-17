import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSyncServer } from "@/lib/server/sync-server";
import { SyncCoordinator } from "@/lib/sync/coordinator";
import { DirtyJournal } from "@/lib/sync/journal";
import { LoroDoc } from "loro-crdt";

describe("synchost debug", () => {
  it("joins tree + doc rooms without hang", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adhd-dbg-"));
    const wsPort = 23111, httpPort = 23112;
    const server = createSyncServer({ port: wsPort, httpPort, vaultPath: tmp, authToken: "t", saveIntervalMs: 50 });
    await server.start();

    const treeDoc = new LoroDoc();
    treeDoc.getText("tree").insert(0, "root");
    treeDoc.commit();
    const marks = new LoroDoc();
    marks.getText("content").insert(0, "hello");
    marks.commit();

    const hooks = {
      getTreeDoc: () => treeDoc,
      getTreeDocumentRoomIds: () => ["doc:doc-1"],
      getSyncedRoomIds: () => [],
      getRoomDoc: async () => marks,
      getBinaryData: async () => null,
      getMissingBinaryIds: async () => [],
    };
    const c = new SyncCoordinator({ wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl: `http://127.0.0.1:${httpPort}`, authToken: "t", vaultId: "v" }, new DirtyJournal(), hooks);
    console.log("sync start");
    const report = await Promise.race([
      c.sync().then((r) => { console.log("sync done", JSON.stringify(r)); return r; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("sync timeout")), 4000)),
    ]) as Awaited<ReturnType<SyncCoordinator["sync"]>>;
    expect(report.docsSynced).toBeGreaterThan(0);
    c.disconnect();
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });
});