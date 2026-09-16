import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LoroDoc, VersionVector } from "loro-crdt";
import { LoroWebsocketClient, type LoroWebsocketClientOptions } from "loro-websocket/client";
import { LoroAdaptor } from "loro-adaptors/loro";
import { createSyncServer, durableVersionOf } from "@/lib/server/sync-server";
import { request } from "http";

let tmpDir: string;
let server: ReturnType<typeof createSyncServer>;
let wsPort: number;
let httpPort: number;

const AUTH = "test-token";

function httpGet(
  port: number,
  path: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-e2e-"));
  wsPort = 21000 + Math.floor(Math.random() * 1000);
  httpPort = wsPort + 1;
  server = createSyncServer({
    port: wsPort,
    httpPort,
    vaultPath: tmpDir,
    authToken: AUTH,
    saveIntervalMs: 60,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

function coversServer(localVV: VersionVector, serverBase64: string): boolean {
  const serverVV = VersionVector.decode(
    Uint8Array.from(Buffer.from(serverBase64, "base64")),
  );
  for (const [peer, counter] of localVV.toJSON()) {
    const serverCounter = serverVV.get(peer) ?? 0;
    if (serverCounter < counter) return false;
  }
  return true;
}

/**
 * Insert content BEFORE the doc is connected (pre-join), so the join
 * handshake exports the full snapshot to the server. This is how the
 * real editor bootstrap works (local edits precede the sync session).
 */
describe("sync server durable confirm (§20)", () => {
  it("confirms the durable version covers a pre-join edit", async () => {
    const roomId = "vault-root";
    const doc = new LoroDoc();
    const text = doc.getText("content");
    text.insert(0, "hello");
    doc.commit();
    const vvBefore = doc.version();

    const adaptor = new LoroAdaptor(doc);
    const client = new LoroWebsocketClient({
      url: `ws://127.0.0.1:${wsPort}`,
      disablePing: true,
    } as LoroWebsocketClientOptions);
    await client.connect();
    const room = await client.join({
      roomId,
      crdtAdaptor: adaptor,
      auth: new TextEncoder().encode(AUTH),
    });
    await room.waitForReachingServerVersion();
    await new Promise((r) => setTimeout(r, 300));

    const { status, body } = await httpGet(httpPort, `/api/durable/${roomId}`, AUTH);
    expect(status).toBe(200);
    const { durableVersion } = JSON.parse(body) as { durableVersion: string };
    expect(coversServer(vvBefore, durableVersion)).toBe(true);

    room.leave();
    client.destroy();
  });
});

describe("rejoin picks up server snapshot", () => {
  it("new client receives content persisted by a prior client", async () => {
    const roomId = "doc:rejoin-test";

    const doc1 = new LoroDoc();
    doc1.getText("content").insert(0, "persist-me");
    doc1.commit();
    const adaptor1 = new LoroAdaptor(doc1);
    const c1 = new LoroWebsocketClient({
      url: `ws://127.0.0.1:${wsPort}`,
      disablePing: true,
    } as LoroWebsocketClientOptions);
    await c1.connect();
    const r1 = await c1.join({
      roomId,
      crdtAdaptor: adaptor1,
      auth: new TextEncoder().encode(AUTH),
    });
    await r1.waitForReachingServerVersion();
    await new Promise((r) => setTimeout(r, 400));

    r1.leave();
    await new Promise((r) => setTimeout(r, 100));
    c1.destroy();
    await new Promise((r) => setTimeout(r, 200));

    const doc2 = new LoroDoc();
    const adaptor2 = new LoroAdaptor(doc2);
    const c2 = new LoroWebsocketClient({
      url: `ws://127.0.0.1:${wsPort}`,
      disablePing: true,
    } as LoroWebsocketClientOptions);
    await c2.connect();
    const r2 = await c2.join({
      roomId,
      crdtAdaptor: adaptor2,
      auth: new TextEncoder().encode(AUTH),
    });
    await r2.waitForReachingServerVersion();
    await new Promise((r) => setTimeout(r, 300));

    expect(doc2.getText("content").toString()).toBe("persist-me");

    r2.leave();
    c2.destroy();
  });
});

describe("discovery HTTP API (§19/§21)", () => {
  it("lists changes after a sequence", async () => {
    const res = await httpGet(httpPort, "/api/changes?after=0", AUTH);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { reset: boolean; changes: unknown[] };
    expect(Array.isArray(parsed.changes)).toBe(true);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await httpGet(httpPort, "/api/rooms");
    expect(res.status).toBe(401);
  });

  it("lists rooms", async () => {
    const res = await httpGet(httpPort, "/api/rooms", AUTH);
    expect(res.status).toBe(200);
    const rooms = JSON.parse(res.body) as { roomId: string }[];
    expect(rooms.some((r) => r.roomId === "vault-root")).toBe(true);
  });
});

describe("durableVersionOf unit", () => {
  it("derives a version vector that covers the source doc", () => {
    const doc = new LoroDoc();
    doc.getText("t").insert(0, "abc");
    doc.commit();
    const vv = doc.version();
    const bytes = durableVersionOf(doc.export({ mode: "snapshot" }));
    const parsed = VersionVector.decode(bytes);
    for (const [peer, counter] of vv.toJSON()) {
      expect(parsed.get(peer) ?? 0).toBe(counter);
    }
  });
});