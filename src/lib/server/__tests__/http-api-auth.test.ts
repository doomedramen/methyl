import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer, request, type Server } from "http";
import type { AddressInfo } from "net";
import { ServerStore } from "@/lib/server/store";
import { createHttpApi } from "@/lib/server/sync-server";
import { subscribeToChanges } from "@/lib/sync/events";

const AUTH = "test-token";
let tmpDir: string;
let store: ServerStore;
let http: Server;
let port: number;

function get(path: string, token?: string): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "methyl-http-auth-"));
  store = new ServerStore(join(tmpDir, "sync.sqlite"));
  http = createServer(createHttpApi({ store, authToken: AUTH, assetDir: join(tmpDir, "assets") }));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("HTTP API auth", () => {
  it("locks an address out with 429 after 10 bad tokens, even for the right token", async () => {
    for (let i = 0; i < 10; i++) expect((await get("/api/rooms", "wrong")).status).toBe(401);
    const locked = await get("/api/rooms", AUTH);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("rejects malformed IDs and sequence numbers with 400", async () => {
    expect((await get("/api/durable/a%2F..%2Fb", AUTH)).status).toBe(400);
    expect((await get("/api/durable/%E0%A4%A", AUTH)).status).toBe(400);
    expect((await get("/api/assets/a%20b", AUTH)).status).toBe(400);
    expect((await get("/api/changes?after=-1", AUTH)).status).toBe(400);
    expect((await get("/api/changes?after=3", AUTH)).status).toBe(200);
    expect((await get("/api/durable/doc:unknown", AUTH)).status).toBe(404);
  });

  it("streams recorded changes on /api/events to an authenticated client", async () => {
    const seqs: number[] = [];
    const abort = new AbortController();
    let connected = false;
    const done = subscribeToChanges({
      url: `http://127.0.0.1:${port}/api/events`,
      headers: { authorization: `Bearer ${AUTH}` },
      onConnect: () => (connected = true),
      onChange: (e) => seqs.push(e.seq),
      signal: abort.signal,
    });
    const start = Date.now();
    while (!connected && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 10));
    store.recordChange(store.getNextSeq(), "doc:a", "doc");
    store.recordChange(store.getNextSeq(), "doc:b", "doc");
    while (seqs.length < 2 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 10));
    expect(seqs).toEqual([1, 2]);
    abort.abort();
    await done;
  });

  it("refuses /api/events without the token", async () => {
    expect((await get("/api/events")).status).toBe(401);
  });
});
