import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { LoroDoc } from "loro-crdt";
import { tmpdir } from "os";
import { createSyncServer } from "@/lib/server/sync-server";
import { SyncHost } from "@/lib/browser/sync-host";
import type { SyncReport } from "@/lib/sync/coordinator";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";

let tmpDir: string;
let server: ReturnType<typeof createSyncServer>;
let wsPort: number;
let httpPort: number;
const AUTH = "host-token";
const VAULT = "host-vault";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-host-"));
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

function makeVault(): Promise<VaultEngine> {
  const fs = new MemoryVaultFS();
  const treeStore = new OpfsVaultTreeStore(fs);
  const docStore = new OpfsDocStore(fs);
  return VaultEngine.create(treeStore, docStore, VAULT);
}

/** Like makeVault(), but backed by a caller-supplied fs (so the engine's own store and a SyncHost's journal share one root, as vault.ts wires them in the app). */
function makeVaultOn(fs: MemoryVaultFS): Promise<VaultEngine> {
  const treeStore = new OpfsVaultTreeStore(fs);
  const docStore = new OpfsDocStore(fs);
  return VaultEngine.create(treeStore, docStore, VAULT);
}

function makeHostOptions(engine: VaultEngine, fs: MemoryVaultFS) {
  return {
    fs,
    engine,
    wsUrl: `ws://127.0.0.1:${wsPort}`,
    httpUrl: `http://127.0.0.1:${httpPort}`,
    authToken: AUTH,
    vaultId: VAULT,
  };
}

describe("SyncHost client driver", () => {
  it("persists and reloads the dirty journal across instances", async () => {
    const fs = new MemoryVaultFS();
    const engine = await makeVault();
    const host = await SyncHost.create(makeHostOptions(engine, fs));

    host.journal.markDirty("doc:one", { p1: 3 });
    await host.persistJournal();
    host.disconnect();

    // A second host instance must see the same journal state
    const engine2 = await makeVault();
    const host2 = await SyncHost.create(makeHostOptions(engine2, fs));
    expect(host2.journal.get("doc:one")?.targetVersion).toEqual({ p1: 3 });
    host2.disconnect();
  });

  it("syncs vault docs and confirms durability end to end", async () => {
    const fs = new MemoryVaultFS();
    const engine = await makeVault();
    const doc = engine.createDocument(
      undefined,
      "hello.md",
      "---\ntitle: Hello\n---\n\n# World\n",
    );

    // Local edit that needs durable confirmation
    const active = engine.getDocument(doc.id)!;
    active.doc.commit();
    active.doc.getText("content").insert(0, "sync me\n");
    active.doc.commit();

    const host = await SyncHost.create(makeHostOptions(engine, fs));
    // No race against a fixed deadline here: under a loaded full-suite run
    // a real sync can exceed it, which made this test flaky in CI. Vitest's
    // own per-test timeout is the backstop.
    const report = (await host.sync()) as SyncReport;

    expect(report.docsSynced).toBeGreaterThan(0);
    expect(host.journal.get(`doc:${doc.id}`)).toBeUndefined();
    expect(host.journal.getLastServerSeq()).toBeGreaterThan(0);

    // Journal was persisted after sync
    const raw = await fs.readTextFile(".methyl/sync/journal.json");
    expect(raw).toBeTruthy();
  });

  it("uploads local attachments and downloads them on a second device", async () => {
    const fs = new MemoryVaultFS();
    const engine = await makeVaultOn(fs);
    const bytes = new Uint8Array([0, 17, 34, 255]);
    const asset = await engine.createAttachment("remote.png", bytes);
    const host = await SyncHost.create(makeHostOptions(engine, fs));

    const uploaded = await host.sync();
    expect(uploaded.binariesSynced).toBeGreaterThan(0);
    expect(server.store.getAssetMeta(String(asset.treeId))?.size).toBe(bytes.length);
    await waitFor(() => existsSync(join(tmpDir, "Attachments/remote.png")));
    expect(new Uint8Array(readFileSync(join(tmpDir, "Attachments/remote.png")))).toEqual(bytes);
    host.disconnect();

    const fs2 = new MemoryVaultFS();
    const engine2 = await makeVaultOn(fs2);
    const host2 = await SyncHost.create(makeHostOptions(engine2, fs2));
    const downloaded = await host2.sync();

    expect(downloaded.binariesSynced).toBeGreaterThan(0);
    expect(await engine2.readAttachment(asset.treeId)).toEqual(bytes);
    host2.disconnect();
  }, 15000);

  it("a second vault receives the first vault's notes", async () => {
    // First vault authored a note and synced it
    const fs = new MemoryVaultFS();
    const engine = await makeVaultOn(fs);
    const doc = engine.createDocument(
      undefined,
      "shared.md",
      "---\ntitle: Shared\n---\n\nShared content\n",
    );
    engine.getDocument(doc.id)!.doc.commit();
    const host = await SyncHost.create(makeHostOptions(engine, fs));
    await host.sync();
    await new Promise((r) => setTimeout(r, 300));
    host.disconnect();

    // Second vault on the same server pulls the note via tree discovery.
    // Same fs backs both the engine's store and the host's journal —
    // matching how vault.ts wires one shared OpfsVaultFS in the app.
    const fs2 = new MemoryVaultFS();
    const engine2 = await makeVaultOn(fs2);
    const host2 = await SyncHost.create(makeHostOptions(engine2, fs2));
    await host2.sync();
    await new Promise((r) => setTimeout(r, 300));

    const found = engine2.tree.documentIds();
    expect(found).toContain(doc.id);
    expect(engine2.getDocument(doc.id)?.getText("content").toString()).toBe(
      "---\ntitle: Shared\n---\n\nShared content\n",
    );
    host2.disconnect();

    // The synced content and tree must also have been persisted to the
    // vault's own store (not just held in the live in-memory doc) — a
    // reload of engine2's store, with no server involved, must see it too.
    // This is what makes a remote edit survive a page refresh and what lets
    // the open editor's loro-codemirror binding (which watches doc.subscribe
    // on the *stored* handle, not a copy) pick it up.
    const treeStore2 = new OpfsVaultTreeStore(fs2);
    const docStore2 = new OpfsDocStore(fs2);
    const { engine: reopened } = await VaultEngine.open(treeStore2, docStore2, VAULT);
    expect(reopened.tree.documentIds()).toContain(doc.id);
    const reopenedDoc = reopened.getDocument(doc.id);
    expect(reopenedDoc?.getText("content").toString()).toBe(
      "---\ntitle: Shared\n---\n\nShared content\n",
    );
  });

  it("reports which rooms were touched so the UI can refresh", async () => {
    const fs = new MemoryVaultFS();
    const engine = await makeVault();
    engine.createDocument(undefined, "touched.md", "hello\n");
    const host = await SyncHost.create(makeHostOptions(engine, fs));

    const changes: number[] = [];
    host.onRemoteChange((report) => changes.push(report.touchedRoomIds.length));

    const report = await host.sync();
    expect(report.treeTouched).toBe(true);
    expect(report.touchedRoomIds.length).toBeGreaterThan(0);
    expect(changes).toEqual([report.touchedRoomIds.length]);
    host.disconnect();
  });

  it("two devices independently seeding a same-named note converge on distinct names after sync, on both clients and the server disk", async () => {
    const fsA = new MemoryVaultFS();
    const engineA = await makeVaultOn(fsA);
    const docA = engineA.createDocument(undefined, "welcome.md", "device A's welcome\n");
    engineA.getDocument(docA.id)!.doc.commit();
    const hostA = await SyncHost.create(makeHostOptions(engineA, fsA));

    const fsB = new MemoryVaultFS();
    const engineB = await makeVaultOn(fsB);
    const docB = engineB.createDocument(undefined, "welcome.md", "device B's welcome\n");
    engineB.getDocument(docB.id)!.doc.commit();
    const hostB = await SyncHost.create(makeHostOptions(engineB, fsB));

    await hostA.sync();
    await waitFor(() => existsSync(join(tmpDir, "welcome.md")));

    await hostB.sync();
    // B's sync round both pulls A's node (collision now visible to B) and
    // pushes B's node to the server — resolveTreeNameCollisions runs
    // wherever the collision is first observed (client or server), so a
    // second round on either side clears up anything the first missed.
    await hostB.sync();
    await waitFor(() =>
      engineB.tree.documentIds().includes(docA.id) &&
      engineB.tree.documentIds().includes(docB.id),
    );

    const namesB = [
      engineB.tree.findByDocumentId(docA.id)!.name,
      engineB.tree.findByDocumentId(docB.id)!.name,
    ].sort();
    expect(namesB).toEqual(["welcome 2.md", "welcome.md"]);

    // A round-trips too, once it syncs again.
    await hostA.sync();
    await waitFor(() => engineA.tree.documentIds().includes(docB.id));
    const namesA = [
      engineA.tree.findByDocumentId(docA.id)!.name,
      engineA.tree.findByDocumentId(docB.id)!.name,
    ].sort();
    expect(namesA).toEqual(["welcome 2.md", "welcome.md"]);
    // Both clients agree on *which* document got which name (the CRDT
    // rename converged, not just "two distinct names in some order").
    expect(engineA.tree.findByDocumentId(docA.id)!.name).toBe(
      engineB.tree.findByDocumentId(docA.id)!.name,
    );

    // The server materialized two distinct files, never one overwriting
    // the other.
    // Wait for BOTH files: the collision rename removes the old path and
    // writes the new one, so "welcome 2.md" can exist for a moment while
    // "welcome.md" is still being rewritten (this raced in CI).
    const names = ["welcome.md", "welcome 2.md"];
    await waitFor(() => names.every((n) => existsSync(join(tmpDir, n))));
    const contents = names.map((n) => readFileSync(join(tmpDir, n), "utf8"));
    expect(new Set(contents)).toEqual(
      new Set(["device A's welcome\n", "device B's welcome\n"]),
    );

    hostA.disconnect();
    hostB.disconnect();
  }, 15000);

  it("a device that opened before configuring sync drops its untouched seed note on first connect, adopting the server's notes instead", async () => {
    const { writeSeedMarker } = await import("@/lib/browser/seed-marker");

    // First device: creates real content and syncs it up (server now has
    // content for this vault).
    const fsFirst = new MemoryVaultFS();
    const engineFirst = await makeVaultOn(fsFirst);
    const realDoc = engineFirst.createDocument(undefined, "real-note.md", "real content\n");
    engineFirst.getDocument(realDoc.id)!.doc.commit();
    const hostFirst = await SyncHost.create(makeHostOptions(engineFirst, fsFirst));
    await hostFirst.sync();
    await waitFor(() => existsSync(join(tmpDir, "real-note.md")), 25_000);
    hostFirst.disconnect();

    // Second device: app was opened first (seeding a local welcome note,
    // exactly like vault.ts's createFreshVault), and only *afterwards* did
    // the user open Sync settings and connect.
    const fsSecond = new MemoryVaultFS();
    const engineSecond = await makeVaultOn(fsSecond);
    const seedDoc = engineSecond.createDocument(undefined, "welcome.md", "seed text\n");
    engineSecond.getDocument(seedDoc.id)!.doc.commit();
    await engineSecond.persistTree();
    await engineSecond.persistDocumentIncremental(seedDoc.id);
    await writeSeedMarker(fsSecond, seedDoc.id, "seed text\n");

    const hostSecond = await SyncHost.create(makeHostOptions(engineSecond, fsSecond));
    await hostSecond.sync();
    await waitFor(() => engineSecond.tree.documentIds().includes(realDoc.id), 25_000);

    // The untouched seed is gone locally — replaced by the server's real
    // note, not sitting alongside it as a duplicate.
    expect(engineSecond.tree.documentIds()).not.toContain(seedDoc.id);
    expect(engineSecond.tree.documentIds()).toContain(realDoc.id);
    expect(
      engineSecond.getDocument(realDoc.id)?.getText("content").toString(),
    ).toBe("real content\n");

    hostSecond.disconnect();
  }, 45_000);
});

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

describe("SyncHost sees disk edits made after a room has already been joined", () => {
  // A dedicated server (watching a real filesystem tmp vault) rather than
  // the shared in-memory-fs server above: this exercises the actual
  // watcher -> ServerStore -> live-room-cache path (recordRoomSave /
  // patchCachedRoomIfLoaded in sync-server.ts), which only matters once a
  // real .md file gets edited on disk.
  let tmp: string;
  let diskServer: ReturnType<typeof createSyncServer>;
  let diskWsPort: number;
  let diskHttpPort: number;
  const DISK_AUTH = "disk-token";
  const DISK_VAULT = "disk-vault";

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "adhd-disk-sync-"));
    diskWsPort = 0;
    diskHttpPort = 0;
    diskServer = createSyncServer({
      port: diskWsPort,
      httpPort: diskHttpPort,
      vaultPath: tmp,
      authToken: DISK_AUTH,
      saveIntervalMs: 50,
      watch: true,
      vaultId: DISK_VAULT,
    });
    await diskServer.start();
    // Bound to OS-assigned ports (0 above), so parallel test files never collide.
    ({ ws: diskWsPort, http: diskHttpPort } = diskServer.ports() as { ws: number; http: number });
  });

  afterAll(async () => {
    await diskServer.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a disk edit made after the room is already cached reaches a client's next sync round", async () => {
    const fs = new MemoryVaultFS();
    const engine = await makeVaultOn(fs);
    const doc = engine.createDocument(undefined, "disk-edit.md", "original content\n");
    engine.getDocument(doc.id)!.doc.commit();

    const host = await SyncHost.create({
      fs,
      engine,
      wsUrl: `ws://127.0.0.1:${diskWsPort}`,
      httpUrl: `http://127.0.0.1:${diskHttpPort}`,
      authToken: DISK_AUTH,
      vaultId: DISK_VAULT,
    });

    // First round: creates the room server-side (so it gets cached in
    // SimpleServer's in-memory `rooms` Map — see patchCachedRoomIfLoaded's
    // doc comment) and lets the Node-side vault mirror materialise the .md.
    await host.sync();
    await waitFor(() => existsSync(join(tmp, "disk-edit.md")));

    // Wait until the server's stored room snapshot holds the disk edit.
    // recordRoomSave patches the live room cache before it stores the
    // snapshot, so this also proves a rejoin will see it. (Waiting for "any
    // new doc change row" raced: the client's own periodic room save from
    // the first round could land after the baseline and satisfy it early.)
    const roomId = `doc:${doc.id}`;

    // Edit the file directly on the server's disk, exactly like an external
    // editor would — bypassing the sync protocol entirely.
    writeFileSync(join(tmp, "disk-edit.md"), "original content\nedited on disk\n");

    // The watcher chain (chokidar stability window + ingest debounce + an
    // fs-scanning ingest pass) is normally <1s, but a loaded box can stretch
    // it well past a tight deadline, so poll with generous headroom.
    await waitFor(() => {
      const snapshot = diskServer.store.getRoom(roomId)?.snapshot;
      if (!snapshot) return false;
      return LoroDoc.fromSnapshot(snapshot).getText("content").toString().includes("edited on disk");
    }, 25000);

    // Second sync round: the room was already joined+left once above, so
    // without patchCachedRoomIfLoaded this would still see the pre-edit
    // snapshot no matter how many rounds run.
    await host.sync();

    const clientText = engine.getDocument(doc.id)!.getText("content").toString();
    expect(clientText).toBe("original content\nedited on disk\n");

    host.disconnect();
  }, 30000);

  it("a client save arriving before the watcher ingests a disk edit merges instead of overwriting it", async () => {
    const fs = new MemoryVaultFS();
    const engine = await makeVaultOn(fs);
    const doc = engine.createDocument(undefined, "race.md", "line one\n");
    engine.getDocument(doc.id)!.doc.commit();

    const host = await SyncHost.create({
      fs,
      engine,
      wsUrl: `ws://127.0.0.1:${diskWsPort}`,
      httpUrl: `http://127.0.0.1:${diskHttpPort}`,
      authToken: DISK_AUTH,
      vaultId: DISK_VAULT,
    });
    await host.sync();
    const file = join(tmp, "race.md");
    await waitFor(() => existsSync(file) && readFileSync(file, "utf8") === "line one\n");

    // An external editor appends a line; before the watcher's stability and
    // debounce window has passed, the client edits the same note and syncs.
    writeFileSync(file, "line one\nfrom disk\n");
    const text = engine.getDocument(doc.id)!.getText("content");
    text.insert(0, "from client\n");
    engine.getDocument(doc.id)!.doc.commit();
    // Keep syncing, as the app's scheduler does: under load a round can end
    // before its update is durable, and the next round finishes the job.
    // Without the fix the disk edit is overwritten, so no number of rounds
    // brings it back.
    const converged = () => {
      const onDisk = readFileSync(file, "utf8");
      return onDisk.includes("from disk") && onDisk.includes("from client");
    };
    const deadline = Date.now() + 25_000;
    while (!converged() && Date.now() < deadline) {
      await host.sync();
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(readFileSync(file, "utf8")).toContain("from disk");
    expect(readFileSync(file, "utf8")).toContain("from client");

    host.disconnect();
  }, 30000);

  it("wakes quickly when a new disk note or empty folder appears", async () => {
    const fs = new MemoryVaultFS();
    const engine = await makeVaultOn(fs);
    const host = await SyncHost.create({
      fs,
      engine,
      wsUrl: `ws://127.0.0.1:${diskWsPort}`,
      httpUrl: `http://127.0.0.1:${diskHttpPort}`,
      authToken: DISK_AUTH,
      vaultId: DISK_VAULT,
      intervalMs: 60_000,
    });

    await host.sync();
    host.start();
    try {
      mkdirSync(join(tmp, "External Folder"));
      writeFileSync(join(tmp, "External Folder", "new-note.md"), "created outside the app\n");

      await waitFor(
        () =>
          engine.tree.findByName("External Folder").some((node) => node.kind === "directory") &&
          engine.tree.findByName("new-note.md").some((node) => node.kind === "markdown"),
        12_000,
      );
    } finally {
      host.stop();
    }

    expect(engine.tree.findByName("External Folder")).toHaveLength(1);
    expect(engine.tree.findByName("new-note.md")).toHaveLength(1);
  }, 30000);
});
