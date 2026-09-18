import { SimpleServer, type SimpleServerConfig } from "loro-websocket/server";
import { CrdtType } from "loro-protocol";
import { LoroDoc } from "loro-crdt";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import type { FSWatcher } from "chokidar";
import { ServerStore } from "@/lib/server/store";
import { NodeFSStore, NodeVaultTreeStore } from "@/lib/server/fs-store";
import { VaultEngine, buildPathFromNode } from "@/lib/vault/engine";
import { watchVaultForExternalChanges } from "@/lib/server/vault-watcher";

export interface SyncServerOptions {
  port: number;
  httpPort?: number;
  host?: string;
  vaultPath: string;
  authToken: string;
  saveIntervalMs?: number;
  /**
   * Watch `vaultPath` for external `.md` changes and ingest them (SPEC §5,
   * §25, §26) — default true. Set false in tests that don't want a
   * filesystem watcher running (or that manage their own tmp-dir timing).
   */
  watch?: boolean;
  vaultId?: string;
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

/**
 * loro-websocket's SimpleServer caches a room's decoded document forever
 * once first loaded: `getOrCreateRoomDocument`
 * (node_modules/loro-websocket/dist/server/index.js:587-608) returns the
 * cached `this.rooms.get(roomKey)` entry immediately if present, and
 * nothing ever deletes from `this.rooms` — not `handleLeave` (:576-580,
 * only clears the per-*client* `rooms`/`permissions` sets) nor
 * `handleDisconnect` (:581-586, same). `onLoadDocument` therefore only
 * ever runs the *first* time any client joins a room for this server's
 * process lifetime.
 *
 * That's the gap behind "external disk edit doesn't reach a client that
 * re-syncs": the vault watcher's ingest writes the merged bytes into
 * ServerStore/SQLite (via this function) but a client's subsequent
 * join/rejoin calls `getOrCreateRoomDocument`, which — once the room has
 * been touched by any client at all — hits the cache and never calls
 * `onLoadDocument` again, so it keeps serving the pre-edit snapshot no
 * matter how many discovery-poll rounds run.
 *
 * There's no public API to push an update into an already-cached room
 * (the class comment on `createSyncServer` below already noted this for
 * *live* push to already-open rooms), but `SimpleServer.rooms` is a plain,
 * unencapsulated `Map` field — reaching in and overwriting the cached
 * entry's `data` in place is the only way to make a rejoin see it. This is
 * safe: `data` is always a full LoroDoc snapshot (the same shape
 * `onSaveDocument`/`onLoadDocument` already exchange, and what
 * `durableVersionOf` already treats as the comparison unit for §20), and
 * every snapshot passed here is produced by importing into the *same*
 * engine Document/tree that both directions (client save, disk ingest)
 * share — so it's always a merge-superset of whatever was cached, never a
 * regression.
 */
function patchCachedRoomIfLoaded(
  server: SimpleServer,
  roomId: string,
  data: Uint8Array,
): void {
  const rooms = (server as unknown as { rooms: Map<string, { data: Uint8Array }> }).rooms;
  const roomKey = `${roomId}:${CrdtType.Loro}`;
  const cached = rooms.get(roomKey);
  if (cached) cached.data = data;
}

/**
 * Feed `data` (a full room snapshot, as SimpleServer's onSaveDocument
 * hands us) into the durable-version/discovery bookkeeping ServerStore
 * already maintains for the WS relay — shared by both the normal
 * client-save path and the watcher's ingest-derived changes, so a
 * discovering/reconnecting client sees either kind of change the same way.
 *
 * `liveServer`, when given, also patches SimpleServer's in-memory room
 * cache (see patchCachedRoomIfLoaded) so a client that already joined this
 * room once — and so would otherwise never trigger a fresh
 * `onLoadDocument` — sees this update on its next join/rejoin instead of a
 * stale cached snapshot.
 */
function recordRoomSave(
  store: ServerStore,
  roomId: string,
  data: Uint8Array,
  type: "doc" | "tree",
  liveServer?: SimpleServer,
): void {
  const seq = store.getNextSeq();
  const room = store.getRoom(roomId);
  const newServerSeq = (room?.serverSeq ?? 0) + 1;
  const vvBytes = durableVersionOf(data);
  // loro-websocket's parseRoomKey produces NaN for string crdt types
  // ("%LOR"), and this doesn't otherwise need it: this server persists
  // Loro rooms only, so bind the CrdtType.Loro literal directly.
  store.upsertRoom(roomId, CrdtType.Loro, Buffer.from(data), Buffer.from(vvBytes), newServerSeq);
  store.recordChange(seq, roomId, type === "tree" ? "tree" : "doc");
  if (liveServer) patchCachedRoomIfLoaded(liveServer, roomId, data);
}

export function createSyncServer(options: SyncServerOptions) {
  const store = new ServerStore(`${options.vaultPath}/.adhd/server/sync.sqlite`);
  const assetDir = `${options.vaultPath}/.adhd/server/assets`;
  const vaultId = options.vaultId ?? "local";
  const treeRoomId = `vault:${vaultId}`;

  /**
   * Node-side vault mirror (SPEC §5, §10, §11, §25/§26): a VaultEngine
   * over `.adhd/crdt/**` at `options.vaultPath`, kept as a *derived mirror*
   * of the relay state ServerStore/SQLite already holds — SQLite
   * (`.adhd/server/sync.sqlite`) stays the sync protocol's source of truth
   * (durable versions, discovery, `/api/changes`), unchanged from before
   * this integration, so the tested client-sync path has zero regression
   * risk. The engine's fs-store is the ONLY writer to `.adhd/crdt/**` —
   * nothing else in this server touches that directory, so there is no
   * two-writer conflict.
   *
   * Two directions feed it:
   *   1. client -> server: onSaveDocument (below) imports the same bytes
   *      it just wrote to SQLite into the matching engine Document/tree,
   *      then materialises the .md and touches the sidecar index — so the
   *      Node vault directory always has a real, current .md mirror of
   *      whatever clients have synced, and the watcher (2) never mistakes
   *      that write for an external one.
   *   2. disk -> server: watchVaultForExternalChanges ingests an
   *      externally-edited/moved/new/deleted .md (safety rails from
   *      VaultEngine.ingestExternalChanges apply — never touches
   *      .adhd/crdt, never mass-deletes) and the resulting CRDT bytes are
   *      fed back into ServerStore via recordRoomSave, i.e. exactly the
   *      same durable-version/discovery bookkeeping a client's own save
   *      would produce. `SimpleServer` (loro-websocket) exposes no public
   *      API to push a live update into an already-open room — its
   *      broadcast is internal to its own client-update handling — so an
   *      externally-made change reaches already-connected clients the same
   *      way a second vault already picks up a first vault's notes in this
   *      codebase's tests: via discovery polling
   *      (GET /api/changes?after=...), not an instant push. A live push
   *      would need a change inside loro-websocket itself.
   */
  let engine: VaultEngine | null = null;
  let watcher: FSWatcher | null = null;
  let bootReconciling = false;

  /**
   * Doc ids whose .md mirror is waiting on a tree node that arrives with a
   * later save in the same round (see the doc branch of onSaveDocument).
   * The tree branch drains this once it has imported the node, so a stale
   * doc never blocks the save pipeline (that used to deadlock the whole
   * relay: SimpleServer pipelines saves through the same handler).
   */
  const pendingDocMirrors = new Set<string>();

  async function drainPendingDocMirrors(): Promise<void> {
    const eng = engine;
    if (!eng) return;
    for (const docId of pendingDocMirrors) {
      const node = eng.tree.findByDocumentId(docId);
      const path = node ? buildPathFromNode(eng.tree, node) : null;
      if (path) {
        await eng.materializeDocument(docId, path);
        pendingDocMirrors.delete(docId);
      }
    }
  }

  async function ensureEngine(): Promise<VaultEngine> {
    if (engine) return engine;
    const treeStore = new NodeVaultTreeStore(options.vaultPath);
    const docStore = new NodeFSStore(options.vaultPath);
    const treeSnap = await treeStore.loadSnapshot();
    const hasVault = treeSnap !== null || (await treeStore.loadUpdates()).length > 0;
    engine = hasVault
      ? (await VaultEngine.open(treeStore, docStore, vaultId)).engine
      : await VaultEngine.create(treeStore, docStore, vaultId);
    return engine;
  }

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
      const isTree = roomId === treeRoomId || roomId.startsWith("vault:");
      recordRoomSave(store, roomId, data, isTree ? "tree" : "doc");

      // Mirror into the Node vault: import the same bytes a client just
      // saved, then materialise/persist. Never during the initial boot
      // reconcile — that pass is establishing the mirror's starting state,
      // not reacting to a save.
      if (bootReconciling) return;
      const eng = await ensureEngine();
      if (isTree) {
        eng.tree.doc.import(data);
        eng.tree.doc.commit();
        // A client's tree save can merge in a foreign peer's node that
        // collides (post-merge same-name siblings — see
        // resolveTreeNameCollisions' doc comment); resolve it as a real
        // tree edit before persisting, so a stale duplicate name never
        // gets materialized to disk under a name some other node already
        // owns.
        const renamed = await eng.resolveTreeNameCollisions();
        await eng.persistTreeIncremental();
        // Docs whose .md couldn't be materialized earlier (their node
        // hadn't reached the mirror yet) can be materialized now that the
        // node exists — see drainPendingDocMirrors.
        await drainPendingDocMirrors();
        if (renamed.length > 0) {
          // This rename is a NEW local edit the client that just saved
          // doesn't have yet — record + patch the live room cache the
          // same way the external-change watcher's ingest does, so it
          // reaches every client (including this one) via the normal
          // discovery-poll + rejoin path.
          eng.tree.doc.commit();
          recordRoomSave(store, roomId, eng.tree.doc.export({ mode: "snapshot" }), "tree", server);
        }
        return;
      }
      if (roomId.startsWith("doc:")) {
        const docId = roomId.slice(4);
        await eng.importDocumentUpdate(docId, data);
        await eng.persistDocumentIncremental(docId);
        // Materialize the .md. The mirror tree can lag here: the client's
        // tree room is saved in the SAME round, but its onSaveDocument
        // handler runs concurrently, so this node may arrive a moment
        // after our lookup. Never block the save path for it (SimpleServer
        // pipelines saves — a stall breaks every other room); instead park
        // the docId and let the tree handler (which imports the node)
        // drain it right after. Nothing re-materializes a doc otherwise,
        // which is why this used to flake: a doc-before-tree race left the
        // .md missing forever.
        const node = eng.tree.findByDocumentId(docId);
        const path = node ? buildPathFromNode(eng.tree, node) : null;
        if (node && path) {
          await eng.materializeDocument(docId, path);
        } else {
          pendingDocMirrors.add(docId);
        }
      }
    },
  };

  const server = new SimpleServer(config);
  // The in-process host (src/server/main.ts) routes /api/* itself, so its
  // own HTTP API server must NOT be created here. Tests that want the API
  // on a known port pass `httpPort` explicitly.
  const httpPort = options.httpPort;
  let http: Server | null = null;

  return {
    server,
    store,
    /** The Node-side VaultEngine mirror, once start() has created it. */
    getEngine: () => engine,
    start: async () => {
      const eng = await ensureEngine();

      // Ignore fs events during this initial pass (requirement: don't let
      // the watcher react to the boot reconcile's own writes).
      bootReconciling = true;
      try {
        await eng.reconcileMaterialization();
      } finally {
        bootReconciling = false;
      }

      if (options.watch !== false) {
        watcher = watchVaultForExternalChanges({
          vaultPath: options.vaultPath,
          engine: eng,
          onIngested: (report) => {
            const total =
              report.edited.length +
              report.moved.length +
              report.copied.length +
              report.created.length +
              report.deleted.length;
            if (total > 0) {
              console.log(
                `[sync-server] ingested external change(s): ` +
                  `${report.edited.length} edited, ${report.moved.length} moved, ` +
                  `${report.copied.length} copied, ${report.created.length} created, ` +
                  `${report.deleted.length} deleted`,
              );
            }
          },
          onRoomUpdate: (roomId, update) => {
            // "Broadcast" here means: make it visible to discovery/reconnect
            // (see the class doc above) — there is no live-push API. Pass
            // `server` so an already-cached room (see recordRoomSave /
            // patchCachedRoomIfLoaded) also gets patched in place — without
            // this, a client that already joined the room once would never
            // see this external edit, no matter how many times it re-syncs.
            recordRoomSave(store, roomId, update, roomId.startsWith("vault:") ? "tree" : "doc", server);
          },
          onError: (err) => {
            console.error("[sync-server] vault watcher error:", err);
          },
        });
      }

      await server.start();
      if (httpPort !== undefined) {
        http = createServer(
          createHttpApi({ store, authToken: options.authToken, assetDir }),
        );
        await new Promise<void>((resolve) => http!.listen(httpPort, options.host ?? "0.0.0.0", resolve));
      }
      return httpPort;
    },
    stop: async () => {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
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
