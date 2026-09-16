import { SimpleServer, type SimpleServerConfig } from "loro-websocket/server";
import { CrdtType } from "loro-protocol";
import { LoroDoc } from "loro-crdt";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { ServerStore } from "@/lib/server/store";

export interface SyncServerOptions {
  port: number;
  httpPort?: number;
  host?: string;
  vaultPath: string;
  authToken: string;
  saveIntervalMs?: number;
}

/**
 * Durable version of a saved CRDT snapshot: import the bytes and read the
 * resulting VersionVector (§20). This is what "durably persisted" means to
 * clients comparing dominance.
 */
export function durableVersionOf(data: Uint8Array): Uint8Array {
  const doc = LoroDoc.fromSnapshot(data);
  return doc.version().encode();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export interface HttpApiOptions {
  store: ServerStore;
  authToken: string;
  assetDir: string;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * HTTP discovery + durable-version + asset endpoints.
 * - GET  /api/changes?after=<seq>      → { reset, changes, minRetainedSeq }
 * - GET  /api/durable/<roomId>         → base64 VersionVector (or 404)
 * - PUT  /api/assets/<id>              → store binary (sha256 verified)
 * - GET  /api/assets/<id>              → fetch binary
 * - GET  /api/rooms                    → room + durable summaries
 */
export function createHttpApi(options: HttpApiOptions) {
  const { store, authToken, assetDir } = options;

  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers["authorization"] !== `Bearer ${authToken}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/api/changes") {
      const after = Number(url.searchParams.get("after") ?? "0");
      sendJson(res, 200, store.getChangesAfter(Number.isNaN(after) ? 0 : after));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/durable/")) {
      const roomId = decodeURIComponent(pathname.slice("/api/durable/".length));
      const vv = store.getDurableVersion(roomId);
      if (!vv) {
        sendJson(res, 404, { error: "room unknown" });
        return;
      }
      sendJson(res, 200, { roomId, durableVersion: Buffer.from(vv).toString("base64") });
      return;
    }

    if (req.method === "PUT" && pathname.startsWith("/api/assets/")) {
      const id = decodeURIComponent(pathname.slice("/api/assets/".length));
      void readBody(req)
        .then((body) => {
          const digest = sha256(body);
          mkdirSync(assetDir, { recursive: true });
          writeFileSync(join(assetDir, digest), body);
          const seq = store.getNextSeq();
          store.upsertAsset(id, digest, body.length, seq);
          store.recordChange(seq, id, "asset");
          sendJson(res, 200, { id, size: body.length, sha256: digest });
        })
        .catch((e) => sendJson(res, 400, { error: String(e?.message ?? e) }));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/assets/")) {
      const id = decodeURIComponent(pathname.slice("/api/assets/".length));
      const meta = store.getAssetMeta(id);
      if (!meta) {
        sendJson(res, 404, { error: "asset unknown" });
        return;
      }
      const path = join(assetDir, meta.sha256);
      if (!existsSync(path)) {
        sendJson(res, 404, { error: "asset data missing" });
        return;
      }
      const body = readFileSync(path);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
      return;
    }

    if (req.method === "GET" && pathname === "/api/rooms") {
      sendJson(res, 200, store.listRooms());
      return;
    }

    sendJson(res, 404, { error: "not found" });
  };
}

export function createSyncServer(options: SyncServerOptions) {
  const store = new ServerStore(`${options.vaultPath}/.adhd/server/sync.sqlite`);
  const assetDir = `${options.vaultPath}/.adhd/server/assets`;

  const config: SimpleServerConfig = {
    port: options.port,
    host: options.host ?? "0.0.0.0",
    saveInterval: options.saveIntervalMs ?? 500,

    authenticate: async (
      _roomId: string,
      _crdtType: CrdtType,
      auth: Uint8Array,
    ) => {
      const token = new TextDecoder().decode(auth);
      if (token !== options.authToken) return null;
      return "write";
    },

    onLoadDocument: async (roomId: string, _crdtType: CrdtType) => {
      const room = store.getRoom(roomId);
      if (room && room.snapshot) return room.snapshot;
      return null;
    },

    onSaveDocument: async (
      roomId: string,
      _crdtType: CrdtType,
      data: Uint8Array,
    ) => {
      const seq = store.getNextSeq();
      const room = store.getRoom(roomId);
      const newServerSeq = (room?.serverSeq ?? 0) + 1;
      const vvBytes = durableVersionOf(data);
      // loro-websocket's parseRoomKey produces NaN for string crdt types
      // ("%LOR"), and onSaveDocument doesn't otherwise need it: this server
      // persists Loro rooms only, so bind the CrdtType.Loro literal directly.
      store.upsertRoom(roomId, CrdtType.Loro, Buffer.from(data), Buffer.from(vvBytes), newServerSeq);
      store.recordChange(
        seq,
        roomId,
        roomId === "vault-root" ? "tree" : "doc",
      );
    },
  };

  const server = new SimpleServer(config);
  const httpPort = options.httpPort ?? options.port + 1;
  let http: Server | null = null;

  return {
    server,
    store,
    start: async () => {
      await server.start();
      http = createServer(
        createHttpApi({ store, authToken: options.authToken, assetDir }),
      );
      await new Promise<void>((resolve) => http!.listen(httpPort, options.host ?? "0.0.0.0", resolve));
      return httpPort;
    },
    stop: async () => {
      await server.stop();
      if (http) {
        await new Promise<void>((resolve, reject) => {
          http!.close((err) => (err ? reject(err) : resolve()));
        });
      }
      store.close();
    },
  };
}