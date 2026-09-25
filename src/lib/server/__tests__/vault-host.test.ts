import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LoroDoc } from "loro-crdt";
import { LoroWebsocketClient, type LoroWebsocketClientOptions } from "loro-websocket/client";
import { LoroAdaptor } from "loro-adaptors/loro";
import { VaultHost } from "@/lib/server/vault-host";
import { SyncCoordinator } from "@/lib/sync/coordinator";
import { DirtyJournal } from "@/lib/sync/journal";
import { deriveSyncUrls } from "@/lib/browser/sync-config";
import { TREE_VAULT_ID } from "@/lib/sync/rooms";

const TOKEN = "vault-host-token";
const auth = { authorization: `Bearer ${TOKEN}` };

function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      if (await check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 25);
    };
    void tick();
  });
}

let host: VaultHost | null = null;
let http: Server | null = null;
const clients: LoroWebsocketClient[] = [];
const dirs: string[] = [];

async function serve(options: { vaultsPath?: string; vaultPath?: string; rescanDelayMs?: number }) {
  host = new VaultHost({ ...options, authToken: TOKEN, watch: options.rescanDelayMs !== undefined, log: () => {} });
  await host.start();
  http = createServer((req, res) => host!.handleApi(req, res));
  http.on("upgrade", (req, socket, head) => host!.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "methyl-vault-host-"));
  dirs.push(dir);
  return dir;
}

async function changedIds(url: string): Promise<string[]> {
  const res = await fetch(url, { headers: auth });
  const body = (await res.json()) as { changes: { objectId: string }[] };
  return body.changes.map((c) => c.objectId);
}

async function writeNote(wsUrl: string, roomId: string, text: string): Promise<void> {
  const client = new LoroWebsocketClient({ url: wsUrl, disablePing: true } as LoroWebsocketClientOptions);
  clients.push(client);
  await client.connect();
  const doc = new LoroDoc();
  const room = await client.join({ roomId, crdtAdaptor: new LoroAdaptor(doc), auth: new TextEncoder().encode(TOKEN) });
  await room.waitForReachingServerVersion();
  doc.getText("content").insert(0, text);
  doc.commit();
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  await host?.stop();
  host = null;
  http = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("VaultHost", () => {
  it("serves each folder as its own vault, and keeps their changes apart", async () => {
    const root = tempDir();
    mkdirSync(join(root, "personal"));
    mkdirSync(join(root, "work"));
    mkdirSync(join(root, "Not A Vault"));
    const { base, ws } = await serve({ vaultsPath: root });

    const list = await fetch(`${base}/api/vaults`, { headers: auth }).then((r) => r.json());
    expect(list).toEqual({
      vaults: [{ id: "personal", ready: true }, { id: "work", ready: true }],
      archivedVaults: [],
    });

    await writeNote(`${ws}/sync/personal`, "doc:only-personal", "private");
    await waitFor(async () => (await changedIds(`${base}/api/v/personal/changes?after=0`)).includes("doc:only-personal"));
    expect(await changedIds(`${base}/api/v/work/changes?after=0`)).not.toContain("doc:only-personal");
    expect(host!.get("work")!.store.getRoom("doc:only-personal")).toBeFalsy();
  });

  it("answers 404 for an unknown vault, and 401 without the token", async () => {
    const root = tempDir();
    mkdirSync(join(root, "personal"));
    const { base } = await serve({ vaultsPath: root });
    expect((await fetch(`${base}/api/v/nope/changes?after=0`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/api/v/nope/changes?after=0`)).status).toBe(401);
    expect((await fetch(`${base}/api/v/personal/changes?after=0`)).status).toBe(401);
    expect((await fetch(`${base}/api/vaults`)).status).toBe(401);
  });

  it("serves a single METHYL_VAULT_PATH as `default`, also at the legacy routes", async () => {
    const { base, ws } = await serve({ vaultPath: tempDir() });
    // A client from before multi-vault: socket at "/", API unprefixed.
    await writeNote(ws, "doc:legacy", "old client");
    await waitFor(async () => (await changedIds(`${base}/api/changes?after=0`)).includes("doc:legacy"));
    expect(await changedIds(`${base}/api/v/default/changes?after=0`)).toContain("doc:legacy");
  });

  it("opens a vault folder created while running, and closes one that is removed", async () => {
    const root = tempDir();
    mkdirSync(join(root, "first"));
    const { base } = await serve({ vaultsPath: root, rescanDelayMs: 50 });

    mkdirSync(join(root, "second"));
    await waitFor(() => host!.get("second") !== undefined);
    expect((await fetch(`${base}/api/v/second/changes?after=0`, { headers: auth })).status).toBe(200);

    rmSync(join(root, "second"), { recursive: true, force: true });
    await waitFor(() => !host!.list().some((v) => v.id === "second"));
    expect((await fetch(`${base}/api/v/second/changes?after=0`, { headers: auth })).status).toBe(404);
  }, 15_000);

  it("archives a server vault durably so discovery cannot list or recreate it", async () => {
    const root = tempDir();
    mkdirSync(join(root, "keep"));
    mkdirSync(join(root, "retired"));
    writeFileSync(join(root, "retired", "Note.md"), "preserve me\n");
    const { base } = await serve({ vaultsPath: root });

    const archived = await fetch(`${base}/api/vaults/retired`, { method: "DELETE", headers: auth });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ id: "retired", archived: true });

    const listed = await fetch(`${base}/api/vaults`, { headers: auth }).then((res) => res.json()) as {
      vaults: { id: string }[];
      archivedVaults: string[];
    };
    expect(listed.vaults.map((vault) => vault.id)).toEqual(["keep"]);
    expect(listed.archivedVaults).toContain("retired");
    expect(readFileSync(join(root, ".methyl-server", "archived", "retired", "Note.md"), "utf8"))
      .toBe("preserve me\n");

    const recreated = await fetch(`${base}/api/vaults`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "retired" }),
    });
    expect(recreated.status).toBe(409);

    await new Promise<void>((resolve) => http!.close(() => resolve()));
    await host!.stop();
    http = null;
    host = null;
    const restarted = await serve({ vaultsPath: root });
    const afterRestart = await fetch(`${restarted.base}/api/vaults`, { headers: auth }).then((res) => res.json()) as {
      vaults: { id: string }[];
      archivedVaults: string[];
    };
    expect(afterRestart.vaults.map((vault) => vault.id)).toEqual(["keep"]);
    expect(afterRestart.archivedVaults).toContain("retired");
  });

  it("a sync round through the per-vault URLs lands in that vault only", async () => {
    const root = tempDir();
    mkdirSync(join(root, "work"));
    mkdirSync(join(root, "home"));
    const { base } = await serve({ vaultsPath: root });
    const { apiUrl, wsUrl } = deriveSyncUrls(base, "work");

    const tree = new LoroDoc();
    tree.getText("tree").insert(0, "root");
    tree.commit();
    const note = new LoroDoc();
    note.getText("content").insert(0, "hello work");
    note.commit();
    const coordinator = new SyncCoordinator(
      { wsUrl, apiUrl, authToken: TOKEN, vaultId: TREE_VAULT_ID },
      new DirtyJournal(),
      {
        getTreeDoc: () => tree,
        getTreeDocumentRoomIds: () => ["doc:work-note"],
        getSyncedRoomIds: () => [],
        getRoomDoc: async () => note,
        getBinaryData: async () => null,
        getMissingBinaryIds: async () => [],
      },
    );
    const report = await coordinator.sync();
    expect(report.docsSynced).toBe(1);

    const work = await changedIds(`${base}/api/v/work/changes?after=0`);
    expect(work).toEqual(expect.arrayContaining(["doc:work-note", "vault:local"]));
    expect(await changedIds(`${base}/api/v/home/changes?after=0`)).toEqual([]);
  }, 20_000);
});
