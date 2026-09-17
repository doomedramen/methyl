import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
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
  wsPort = 23000 + Math.floor(Math.random() * 1000);
  httpPort = wsPort + 1;
  server = createSyncServer({
    port: wsPort,
    httpPort,
    vaultPath: tmpDir,
    authToken: AUTH,
    saveIntervalMs: 50,
  });
  await server.start();
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
    console.log("engine doc ids", engine.tree.documentIds(), "tree vv", Object.fromEntries(engine.tree.doc.version().toJSON()), "doc vv", Object.fromEntries(active.doc.version().toJSON()));
    const report = await Promise.race([
      host.sync().then((r) => { console.log("sync report", JSON.stringify(r)); return r; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("sync timeout")), 4000)),
    ]) as SyncReport;

    expect(report.docsSynced).toBeGreaterThan(0);
    expect(host.journal.get(`doc:${doc.id}`)).toBeUndefined();
    expect(host.journal.getLastServerSeq()).toBeGreaterThan(0);

    // Journal was persisted after sync
    const raw = await fs.readTextFile(".adhd/sync/journal.json");
    expect(raw).toBeTruthy();
  });

  it("a second vault receives the first vault's notes", async () => {
    // First vault authored a note and synced it
    const fs = new MemoryVaultFS();
    const engine = await makeVault();
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

    // Second vault on the same server pulls the note via tree discovery
    const fs2 = new MemoryVaultFS();
    const engine2 = await makeVault();
    const host2 = await SyncHost.create(makeHostOptions(engine2, fs2));
    await host2.sync();
    await new Promise((r) => setTimeout(r, 300));

    const found = engine2.tree.documentIds();
    expect(found).toContain(doc.id);
    expect(engine2.getDocument(doc.id)?.getText("content").toString()).toBe(
      "Shared content",
    );
    host2.disconnect();
  });
});