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
    // OS-assigned ports: a fixed pair here once sat inside the range other
    // test files picked from at random, so parallel runs could collide.
    const server = createSyncServer({ port: 0, httpPort: 0, vaultPath: tmp, authToken: "t", saveIntervalMs: 50 });
    await server.start();
    const { ws: wsPort, http: httpPort } = server.ports();

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
    const c = new SyncCoordinator({ wsUrl: `ws://127.0.0.1:${wsPort}`, apiUrl: `http://127.0.0.1:${httpPort}/api`, authToken: "t", vaultId: "v" }, new DirtyJournal(), hooks);
    console.log("sync start");
    // 4000ms left ~1s of headroom under the (default) 5000ms test timeout —
    // too tight when many other test files are also spinning up real
    // WebSocket servers in parallel (Task A3's 30x `vitest run` flaky-hunt
    // reproduced a spurious "sync timeout" here under that load). Both
    // numbers are widened with the same headroom-over-race margin the
    // sync-host disk-watch test uses.
    const report = await Promise.race([
      c.sync().then((r) => { console.log("sync done", JSON.stringify(r)); return r; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("sync timeout")), 15000)),
    ]) as Awaited<ReturnType<SyncCoordinator["sync"]>>;
    expect(report.docsSynced).toBeGreaterThan(0);
    c.disconnect();
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  }, 20000);
});