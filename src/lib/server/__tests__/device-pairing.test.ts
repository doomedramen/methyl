import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LoroDoc } from "loro-crdt";
import { LoroWebsocketClient, type LoroWebsocketClientOptions } from "loro-websocket/client";
import { LoroAdaptor } from "loro-adaptors/loro";
import { VaultHost } from "@/lib/server/vault-host";

const ADMIN = "pairing-admin-token";
const admin = { authorization: `Bearer ${ADMIN}` };

let host: VaultHost | null = null;
let http: Server | null = null;
const clients: LoroWebsocketClient[] = [];
const dirs: string[] = [];

async function serve() {
  const root = mkdtempSync(join(tmpdir(), "methyl-pairing-"));
  dirs.push(root);
  mkdirSync(join(root, "personal"));
  mkdirSync(join(root, "work"));
  host = new VaultHost({ vaultsPath: root, authToken: ADMIN, watch: false, log: () => {} });
  await host.start();
  http = createServer((req, res) => host!.handleApi(req, res));
  http.on("upgrade", (req, socket, head) => host!.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

async function pair(base: string, vaults: unknown, headers: Record<string, string> = admin) {
  return fetch(`${base}/api/auth/pair`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ deviceName: "Test browser", vaults }),
  });
}

/** The cookie pair a browser would send back, from a Set-Cookie header. */
function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie");
  if (!set) throw new Error("no cookie set");
  return set.split(";")[0]!;
}

async function ticketFor(base: string, cookie: string, vault: string): Promise<Response> {
  return fetch(`${base}/api/auth/ws-ticket`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ vault }),
  });
}

async function joinRoom(wsUrl: string, auth: string, roomId = "doc:paired") {
  const client = new LoroWebsocketClient({ url: wsUrl, disablePing: true } as LoroWebsocketClientOptions);
  clients.push(client);
  await client.connect();
  const room = await client.join({ roomId, crdtAdaptor: new LoroAdaptor(new LoroDoc()), auth: new TextEncoder().encode(auth) });
  await room.waitForReachingServerVersion();
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  await host?.stop();
  host = null;
  http = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("device pairing", () => {
  it("pairs with the admin token and sets an HttpOnly, SameSite=Strict cookie", async () => {
    const { base } = await serve();
    const res = await pair(base, ["personal"]);
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^methyl_device=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    // Plain HTTP on loopback is local development: no Secure flag.
    expect(setCookie).not.toContain("Secure");
    // The secret is only in the cookie, never in the response body.
    const body = (await res.json()) as { device: { id: string } };
    expect(JSON.stringify(body)).not.toContain(cookieFrom(res).split(".")[1]);
  });

  it("marks the cookie Secure when not on loopback", async () => {
    const { base } = await serve();
    // fetch() won't send a custom Host header; a raw request will.
    const setCookie = await new Promise<string>((resolve, reject) => {
      const req = request(`${base}/api/auth/pair`, {
        method: "POST",
        headers: { ...admin, host: "methyl.example.com" },
      }, (res) => {
        res.resume();
        resolve(String(res.headers["set-cookie"]));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ vaults: "*" }));
    });
    expect(setCookie).toContain("; Secure");
  });

  it("refuses to pair without the admin token, or with only a device cookie", async () => {
    const { base } = await serve();
    expect((await pair(base, "*", { authorization: "Bearer wrong" })).status).toBe(401);
    const cookie = cookieFrom(await pair(base, ["personal"]));
    expect((await pair(base, "*", { cookie })).status).toBe(401);
  });

  it("a device reaches only the vaults it was paired for", async () => {
    const { base } = await serve();
    const cookie = cookieFrom(await pair(base, ["personal"]));
    expect((await fetch(`${base}/api/v/personal/changes?after=0`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/v/work/changes?after=0`, { headers: { cookie } })).status).toBe(403);
    expect(await fetch(`${base}/api/vaults`, { headers: { cookie } }).then((r) => r.json())).toEqual({
      vaults: [{ id: "personal", ready: true }],
      archivedVaults: [],
    });
    expect((await fetch(`${base}/api/vaults`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "new-vault" }),
    })).status).toBe(403);
    expect((await ticketFor(base, cookie, "work")).status).toBe(403);
    // Pairing again from the same browser adds a vault to the same device.
    const again = await pair(base, ["work"], { ...admin, cookie });
    expect(again.status).toBe(200);
    expect((await fetch(`${base}/api/v/work/changes?after=0`, { headers: { cookie } })).status).toBe(200);
    expect(host!.devices.list()).toHaveLength(1);
  });

  it("only an admin or wildcard-paired browser can archive vaults", async () => {
    const { base } = await serve();
    const cookie = cookieFrom(await pair(base, ["personal"]));
    expect((await fetch(`${base}/api/vaults/personal`, { method: "DELETE", headers: { cookie } })).status).toBe(403);

    const wildcardCookie = cookieFrom(await pair(base, "*"));
    const archived = await fetch(`${base}/api/vaults/personal`, { method: "DELETE", headers: { cookie: wildcardCookie } });
    expect(archived.status).toBe(200);
    const listing = await fetch(`${base}/api/vaults`, { headers: { cookie } }).then((res) => res.json());
    expect(listing).toEqual({ vaults: [], archivedVaults: ["personal"] });

    expect((await fetch(`${base}/api/vaults/work`, { method: "DELETE", headers: admin })).status).toBe(200);
  });

  it("a wildcard-paired browser can create server vaults for automatic sync", async () => {
    const { base } = await serve();
    const cookie = cookieFrom(await pair(base, "*"));
    const created = await fetch(`${base}/api/vaults`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "new-vault" }),
    });
    expect(created.status).toBe(201);
    expect(await fetch(`${base}/api/v/new-vault/changes?after=0`, { headers: { cookie } }).then((r) => r.status)).toBe(200);
  });

  it("sync joins take a ticket, which one connection redeems", async () => {
    const { base, ws } = await serve();
    const cookie = cookieFrom(await pair(base, ["personal"]));
    const { ticket } = (await (await ticketFor(base, cookie, "personal")).json()) as { ticket: string };

    await joinRoom(`${ws}/sync/personal`, ticket);
    await expect(joinRoom(`${ws}/sync/personal`, ticket, "doc:other")).rejects.toThrow();
    // A ticket for one vault doesn't open another.
    const second = ((await (await ticketFor(base, cookie, "personal")).json()) as { ticket: string }).ticket;
    await expect(joinRoom(`${ws}/sync/work`, second)).rejects.toThrow();
    // The admin token still works for scripts.
    await joinRoom(`${ws}/sync/work`, ADMIN);
  });

  it("revoking a device drops its sockets and logs it out", async () => {
    const { base, ws } = await serve();
    const cookie = cookieFrom(await pair(base, "*"));
    const { device } = (await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()) as {
      device: { id: string };
    };
    const { ticket } = (await (await ticketFor(base, cookie, "personal")).json()) as { ticket: string };
    const client = await joinRoom(`${ws}/sync/personal`, ticket);
    const closed = new Promise<void>((resolve) => client.socket.addEventListener("close", () => resolve()));

    const res = await fetch(`${base}/api/auth/devices/${device.id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    await closed;
    expect((await fetch(`${base}/api/v/personal/changes?after=0`, { headers: { cookie } })).status).toBe(401);
  });

  it("only the admin token removes another device", async () => {
    const { base } = await serve();
    const phone = cookieFrom(await pair(base, "*"));
    await pair(base, "*"); // a second browser (no cookie sent)
    const list = (await (await fetch(`${base}/api/auth/devices`, { headers: { cookie: phone } })).json()) as {
      devices: { id: string; current: boolean }[];
    };
    expect(list.devices).toHaveLength(2);
    const other = list.devices.find((d) => !d.current)!;
    expect((await fetch(`${base}/api/auth/devices/${other.id}`, { method: "DELETE", headers: { cookie: phone } })).status).toBe(403);
    expect((await fetch(`${base}/api/auth/devices/${other.id}`, { method: "DELETE", headers: admin })).status).toBe(200);
  });
});
