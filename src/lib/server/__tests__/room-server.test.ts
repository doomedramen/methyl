import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { LoroDoc } from "loro-crdt";
import { LoroWebsocketClient, type LoroWebsocketClientOptions } from "loro-websocket/client";
import { LoroAdaptor } from "loro-adaptors/loro";
import { RoomServer, type RoomServerOptions } from "@/lib/server/room-server";

const TOKEN = "room-token";
const encoder = new TextEncoder();

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

let http: Server | null = null;
let rooms: RoomServer | null = null;
const clients: LoroWebsocketClient[] = [];

async function start(overrides: Partial<RoomServerOptions> = {}) {
  const stored = new Map<string, Uint8Array>();
  rooms = new RoomServer({
    authenticate: async (_roomId, auth) => (new TextDecoder().decode(auth) === TOKEN ? "write" : null),
    load: (roomId) => stored.get(roomId) ?? null,
    save: (roomId, snapshot) => {
      stored.set(roomId, snapshot);
    },
    saveIntervalMs: 20,
    ...overrides,
  });
  rooms.start();
  http = createServer();
  rooms.attach(http);
  await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { url, stored };
}

async function connect(url: string) {
  const client = new LoroWebsocketClient({ url, disablePing: true } as LoroWebsocketClientOptions);
  clients.push(client);
  await client.connect();
  return client;
}

async function join(client: LoroWebsocketClient, roomId: string, doc: LoroDoc, token = TOKEN) {
  const room = await client.join({ roomId, crdtAdaptor: new LoroAdaptor(doc), auth: encoder.encode(token) });
  await room.waitForReachingServerVersion();
  return room;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await rooms?.stop();
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  rooms = null;
  http = null;
});

describe("RoomServer", () => {
  it("relays edits between clients live, and saves the room", async () => {
    const { url, stored } = await start();
    const a = new LoroDoc();
    const b = new LoroDoc();
    await join(await connect(url), "doc:one", a);
    await join(await connect(url), "doc:one", b);

    a.getText("content").insert(0, "hello from a");
    a.commit();
    await waitFor(() => b.getText("content").toString() === "hello from a");

    await waitFor(() => stored.has("doc:one"));
    const saved = LoroDoc.fromSnapshot(stored.get("doc:one")!);
    expect(saved.getText("content").toString()).toBe("hello from a");
  });

  it("a client joining later receives the room's content", async () => {
    const { url } = await start();
    const a = new LoroDoc();
    await join(await connect(url), "doc:two", a);
    a.getText("content").insert(0, "before you came");
    a.commit();
    await new Promise((r) => setTimeout(r, 100));

    const late = new LoroDoc();
    await join(await connect(url), "doc:two", late);
    await waitFor(() => late.getText("content").toString() === "before you came");
  });

  it("push() sends a server-side change to everyone in the room", async () => {
    const { url } = await start();
    const client = new LoroDoc();
    await join(await connect(url), "doc:three", client);

    const server = new LoroDoc();
    server.import(rooms!.snapshot("doc:three")!);
    server.getText("content").insert(0, "edited on disk");
    server.commit();
    rooms!.push("doc:three", server.export({ mode: "snapshot" }));

    await waitFor(() => client.getText("content").toString() === "edited on disk");
  });

  it("refuses a join with the wrong token", async () => {
    const { url } = await start();
    await expect(join(await connect(url), "doc:four", new LoroDoc(), "wrong")).rejects.toThrow();
  });

  it("an update arriving during a slow save is saved too", async () => {
    let release!: () => void;
    let firstSave = true;
    const saves: string[] = [];
    const { url } = await start({
      save: async (_roomId, snapshot) => {
        saves.push(LoroDoc.fromSnapshot(snapshot).getText("content").toString());
        if (firstSave) {
          firstSave = false;
          await new Promise<void>((r) => (release = r));
        }
      },
    });
    const doc = new LoroDoc();
    await join(await connect(url), "doc:five", doc);
    doc.getText("content").insert(0, "one");
    doc.commit();
    await waitFor(() => saves.length === 1);
    // Arrives while the first save is still in progress.
    doc.getText("content").insert(3, " two");
    doc.commit();
    await new Promise((r) => setTimeout(r, 100));
    release();
    await waitFor(() => saves.at(-1) === "one two");
  });

  it("an evicted room is loaded again from storage", async () => {
    const { url, stored } = await start({ idleEvictMs: 0, heartbeatMs: 30 });
    const a = new LoroDoc();
    const client = await connect(url);
    const room = await join(client, "doc:six", a);
    a.getText("content").insert(0, "kept");
    a.commit();
    await waitFor(() => stored.has("doc:six"));
    room.leave();
    await waitFor(() => rooms!.snapshot("doc:six") === null, 3000);

    const again = new LoroDoc();
    await join(await connect(url), "doc:six", again);
    await waitFor(() => again.getText("content").toString() === "kept");
  });
});
