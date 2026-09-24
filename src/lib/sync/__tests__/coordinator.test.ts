import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LoroDoc, VersionVector } from "loro-crdt";
import { createSyncServer } from "@/lib/server/sync-server";
import { SyncCoordinator, type SyncHooks } from "@/lib/sync/coordinator";
import { DirtyJournal, coversVersion } from "@/lib/sync/journal";

let tmpDir: string;
let server: ReturnType<typeof createSyncServer>;
let wsPort: number;
let httpPort: number;
const AUTH = "coord-token";
const VAULT = "test-vault";
const DOC_A = "doc:alpha";
const DOC_B = "doc:beta";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-coord-"));
  wsPort = 0;
  httpPort = 0;
  server = createSyncServer({
    port: wsPort,
    httpPort,
    vaultPath: tmpDir,
    authToken: AUTH,
    saveIntervalMs: 50,
  });
  await server.start();
  // Bound to OS-assigned ports (0 above), so parallel test files never collide.
  ({ ws: wsPort, http: httpPort } = server.ports() as { ws: number; http: number });
});

afterAll(async () => {
  await server.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

type DocSet = Map<string, LoroDoc>;

function makeHooks(docs: DocSet): SyncHooks {
  const treeDoc = new LoroDoc();
  treeDoc.getText("tree").insert(0, "root");
  treeDoc.commit();
  docs.set(`vault:${VAULT}`, treeDoc);
  return {
    getTreeDoc: () => treeDoc,
    getTreeDocumentRoomIds: () =>
      [...docs.keys()].filter((id) => id.startsWith("doc:")),
    getSyncedRoomIds: () => [],
    getRoomDoc: async (roomId) => docs.get(roomId) ?? null,
    getBinaryData: async () => null,
    getMissingBinaryIds: async () => [],
  };
}

function durableCovers(roomId: string, target: LoroDoc): Promise<boolean> {
  return fetch(`http://127.0.0.1:${httpPort}/api/durable/${roomId}`, {
    headers: { authorization: `Bearer ${AUTH}` },
  })
    .then((r) => (r.ok ? r.json() as Promise<{ durableVersion: string }> : null))
    .then((body) => {
      if (!body) return false;
      const durable = Object.fromEntries(
        VersionVector.decode(
          Uint8Array.from(Buffer.from(body.durableVersion, "base64")),
        ).toJSON(),
      );
      const local = Object.fromEntries(target.version().toJSON());
      return coversVersion(durable, local);
    });
}

describe("SyncCoordinator §34", () => {
  it("fails a dead WebSocket handshake instead of hanging indefinitely", async () => {
    const coordinator = new SyncCoordinator(
      {
        wsUrl: "ws://127.0.0.1:1",
        httpUrl: `http://127.0.0.1:${httpPort}`,
        authToken: AUTH,
        vaultId: VAULT,
        connectionTimeoutMs: 50,
      },
      new DirtyJournal(),
      makeHooks(new Map()),
    );

    await expect(coordinator.sync()).rejects.toThrow(/WebSocket/);
  });

  it("syncs docs, confirms durable versions, clears dirty entries", async () => {
    // Local vault: two docs with unpushed edits
    const docs: DocSet = new Map();
    const alpha = new LoroDoc();
    alpha.getText("content").insert(0, "hello alpha");
    alpha.commit();
    docs.set(DOC_A, alpha);
    const beta = new LoroDoc();
    beta.getText("content").insert(0, "hello beta");
    beta.commit();
    docs.set(DOC_B, beta);

    const journal = new DirtyJournal();
    const coordinator = new SyncCoordinator(
      {
        wsUrl: `ws://127.0.0.1:${wsPort}`,
        httpUrl: `http://127.0.0.1:${httpPort}`,
        authToken: AUTH,
        vaultId: VAULT,
      },
      journal,
      makeHooks(docs),
    );

    const report = await coordinator.sync();
    // Both local docs must sync. Not an exact count: the shared test server
    // runs its own vault mirror, so discovery can legitimately turn up an
    // extra room in the same pass (this assertion was flaky in CI).
    expect(report.docsSynced).toBeGreaterThanOrEqual(2);
    expect(report.touchedRoomIds).toEqual(
      expect.arrayContaining([expect.stringContaining(DOC_A), expect.stringContaining(DOC_B)]),
    );

    // Wait for server save interval + durable write
    await new Promise((r) => setTimeout(r, 300));

    expect(await durableCovers(DOC_A, alpha)).toBe(true);
    expect(await durableCovers(DOC_B, beta)).toBe(true);

    // Journal advanced; dirty entries cleared once durable
    expect(journal.get(DOC_A)).toBeUndefined();
    expect(journal.get(DOC_B)).toBeUndefined();
    expect(journal.getLastServerSeq()).toBeGreaterThan(0);
  });

  it("a fresh empty vault pulls server content via tree discovery", async () => {
    // First: what docs does the server already know existed? The vault tree
    // room was never created on the server (tree room I/O is periodic), but
    // discovery via changes?after=lastSeq must return the doc rooms.
    const lastSeq = 0;
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/api/changes?after=${lastSeq}`,
      { headers: { authorization: `Bearer ${AUTH}` } },
    );
    const body = await res.json() as { changes: Array<{ objectId: string }> };
    expect(body.changes.map((c) => c.objectId)).toContain(DOC_A);
    expect(body.changes.map((c) => c.objectId)).toContain(DOC_B);
  });

  it("second client receives persisted content", async () => {
    // Fresh docs / empty vault — coordinator connects, discovers changed
    // rooms, joins them, and materializes the content.
    const docX = new LoroDoc();
    const docs: DocSet = new Map([[DOC_A, docX]]);

    const journal = new DirtyJournal();
    const coordinator = new SyncCoordinator(
      {
        wsUrl: `ws://127.0.0.1:${wsPort}`,
        httpUrl: `http://127.0.0.1:${httpPort}`,
        authToken: AUTH,
        vaultId: VAULT,
      },
      journal,
      makeHooks(docs),
    );

    const report = await coordinator.sync();
    expect(report.docsSynced).toBeGreaterThan(0);

    // Content from the first client should now be in the fresh doc
    expect(docX.getText("content").toString()).toBe("hello alpha");
  });
});
