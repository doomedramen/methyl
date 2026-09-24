import { LoroWebsocketClient, type LoroWebsocketClientOptions } from "loro-websocket/client";
import { LoroAdaptor } from "loro-adaptors/loro";
import { LoroDoc, VersionVector } from "loro-crdt";
import {
  DirtyJournal,
  buildWorkSet,
  coversVersion,
  type VersionVector as VV,
} from "@/lib/sync/journal";
import { testWebSocketConnection } from "@/lib/sync/websocket";

export interface SyncCoordinatorOptions {
  wsUrl: string;
  httpUrl: string;
  authToken: string;
  vaultId: string;
  maxConcurrentDocs?: number;   // §34: 8 on mobile
  maxConcurrentBinaries?: number; // §34: 2 on mobile
  /** Bound a dead reverse-proxy/WebSocket handshake instead of hanging forever. */
  connectionTimeoutMs?: number;
  /** Run after transport preflight and before any local seed is removed. */
  beforeConnect?: () => Promise<void>;
}

export interface SyncReport {
  docsSynced: number;
  binariesSynced: number;
  dirtyCleared: number;
  durationMs: number;
  /** Room ids (`doc:<id>`) that reached the server version this round — includes both locally-dirty and remotely-changed rooms, so the caller can persist/materialize them. */
  touchedRoomIds: string[];
  /** The vault tree room was joined and synced this round. */
  treeTouched: boolean;
}

export interface SyncHooks {
  getTreeDoc(): LoroDoc;
  getTreeDocumentRoomIds(): string[];
  getSyncedRoomIds(): string[];
  getRoomDoc(roomId: string): Promise<LoroDoc | null>;
  getBinaryData(assetId: string): Promise<Uint8Array | null>;
  writeBinaryData?(assetId: string, data: Uint8Array): Promise<void>;
  getBinaryIds?(): Promise<string[]>;
  getMissingBinaryIds(): Promise<string[]>;
}

/* ── bounded concurrency ─────────────────────────────────────────── */

function bounded(limit: number): [acquire: () => Promise<void>, release: () => void] {
  let active = 0;
  const queue: Array<() => void> = [];
  return [
    () =>
      new Promise<void>((resolve) => {
        if (active < limit) { active++; resolve(); return; }
        queue.push(() => { active++; resolve(); });
      }),
    () => { active--; if (queue.length > 0) queue.shift()?.(); },
  ];
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/* ── base64 → VersionVector ─────────────────────────────────────── */

function vvFromBase64(b64: string): VV {
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  return Object.fromEntries(VersionVector.decode(bytes).toJSON()) as VV;
}

/* ── SyncCoordinator ─────────────────────────────────────────────── */

export class SyncCoordinator {
  private readonly opts: Required<Pick<SyncCoordinatorOptions,
    "maxConcurrentDocs" | "maxConcurrentBinaries" | "connectionTimeoutMs" >> & SyncCoordinatorOptions;
  private readonly journal: DirtyJournal;
  private readonly hooks: SyncHooks;
  private client: LoroWebsocketClient | null = null;
  private running = false;

  constructor(
    options: SyncCoordinatorOptions,
    journal: DirtyJournal,
    hooks: SyncHooks,
  ) {
    this.opts = {
      ...options,
      maxConcurrentDocs: options.maxConcurrentDocs ?? 8,
      maxConcurrentBinaries: options.maxConcurrentBinaries ?? 2,
      connectionTimeoutMs: options.connectionTimeoutMs ?? 10_000,
    };
    this.journal = journal;
    this.hooks = hooks;
  }

  /** Run the §34 reconnect loop. No-op if already running. */
  async sync(): Promise<SyncReport> {
    if (this.running) {
      return { docsSynced: 0, binariesSynced: 0, dirtyCleared: 0, durationMs: 0, touchedRoomIds: [], treeTouched: false };
    }
    this.running = true;
    const t0 = Date.now();
    try { return { ...(await this.loop()), durationMs: Date.now() - t0 }; }
    finally { this.running = false; }
  }

  disconnect(): void {
    this.client?.destroy();
    this.client = null;
  }

  /* ── §34 core loop ─────────────────────────────────────────────── */

  private async loop(): Promise<SyncReport> {
    const { wsUrl, httpUrl, authToken, vaultId } = this.opts;
    const hdr = { authorization: `Bearer ${authToken}` };

    // 2-4: connect WS
    console.log("coord: connecting");
    await testWebSocketConnection(wsUrl, this.opts.connectionTimeoutMs);
    await this.opts.beforeConnect?.();
    const client = new LoroWebsocketClient({ url: wsUrl, disablePing: true } as LoroWebsocketClientOptions);
    this.client = client;
    let treeRoom: { waitForReachingServerVersion(): Promise<void>; leave(): void } | null = null;
    try {
      await withTimeout(client.connect(), "WebSocket connection", this.opts.connectionTimeoutMs);
      console.log("coord: connected");

      // 5-6: join vault tree room, wait for server version
      const treeDoc = this.hooks.getTreeDoc();
      const treeAdaptor = new LoroAdaptor(treeDoc);
      console.log("coord: joining tree room vault:" + vaultId);
      treeRoom = await withTimeout(
        client.join({
          roomId: `vault:${vaultId}`,
          crdtAdaptor: treeAdaptor,
          auth: new TextEncoder().encode(authToken),
        }),
        "Vault room join",
        this.opts.connectionTimeoutMs,
      );
      console.log("coord: tree room joined, waiting server version");
      await withTimeout(
        treeRoom.waitForReachingServerVersion(),
        "Vault tree sync",
        this.opts.connectionTimeoutMs,
      );
      console.log("coord: tree synced");

      // 7: discovery poll
      const lastSeq = this.journal.getLastServerSeq();
      console.log("coord: discovery after", lastSeq);
      const changesRes = await fetch(`${httpUrl}/api/changes?after=${lastSeq}`, { headers: hdr });
      const { changes: serverChanges } = await changesRes.json() as {
        reset?: boolean;
        changes: Array<{ objectId: string; seq: number; type?: string }>;
      };
      console.log("coord: changes", serverChanges.length);

      // 8: build work set
      const knownSynced = new Set(this.hooks.getSyncedRoomIds());
      console.log("coord: getSyncedRoomIds", knownSynced.size);
      const missingBinaries = await this.hooks.getMissingBinaryIds();
      const localBinaryIds = await this.hooks.getBinaryIds?.() ?? [];
      console.log("coord: missing binaries", missingBinaries.length);
      console.log("coord: tree ids...", this.hooks.getTreeDocumentRoomIds().length);
      const { documents, binaries } = buildWorkSet({
        localDirty: this.journal.dirty().map((e) => e.roomId),
        serverChanged: serverChanges
          .filter((change) => change.type !== "asset")
          .map((c) => c.objectId),
        serverChangedBinaries: serverChanges
          .filter((change) => change.type === "asset")
          .map((c) => c.objectId),
        treeDocumentIds: this.hooks.getTreeDocumentRoomIds(),
        knownSynced,
        binaryIds: localBinaryIds,
        missingBinaries,
      });
      console.log("coord: work set", documents.length, binaries.length);

      // 9: sync doc rooms
      const touchedRoomIds: string[] = [];
      const docsSynced = await this.syncDocs(documents, client, authToken, touchedRoomIds, httpUrl, hdr);

      // 10: sync binaries
      const binariesSynced = await this.syncBinaries(binaries, httpUrl, hdr);

      // 11-12: durable confirm + clear
      const dirtyCleared = await this.confirmDurables(httpUrl, hdr);

      // 13: advance lastServerSeq. Re-poll after sync: rooms we synced (and
      // the tree) have produced new change-log rows, so reflect them now so
      // the next discovery poll skips everything already durably sent.
      const afterRes = await fetch(`${httpUrl}/api/changes?after=${lastSeq}`, { headers: hdr });
      const { changes: afterChanges } = await afterRes.json() as {
        changes: Array<{ objectId: string; seq: number; type?: string }>;
      };
      if (afterChanges.length > 0) {
        const maxSeq = Math.max(...afterChanges.map((c) => c.seq));
        this.journal.setServerSeq(maxSeq);
      }

      return { docsSynced, binariesSynced, dirtyCleared, durationMs: 0, touchedRoomIds, treeTouched: true };
    } finally {
      treeRoom?.leave();
      client.destroy();
      if (this.client === client) this.client = null;
    }
  }

  /* ── room sync (bounded concurrency) ───────────────────────────── */

  private async syncDocs(
    roomIds: string[],
    client: LoroWebsocketClient,
    authToken: string,
    touched: string[],
    httpUrl: string,
    hdr: Record<string, string>,
  ): Promise<number> {
    if (roomIds.length === 0) return 0;
    const [acquire, release] = bounded(this.opts.maxConcurrentDocs);
    let count = 0;

    await Promise.all(roomIds.map(async (id) => {
      console.log("coord: doc task start", id);
      await acquire();
      console.log("coord: doc acquired", id);
      try {
        const doc = await this.hooks.getRoomDoc(id);
        console.log("coord: syncing doc room", id, "doc?", !!doc);
        if (!doc) return;
        const adaptor = new LoroAdaptor(doc);
        const room = await withTimeout(
          client.join({
            roomId: id,
            crdtAdaptor: adaptor,
            auth: new TextEncoder().encode(authToken),
          }),
          `Document room join (${id})`,
          this.opts.connectionTimeoutMs,
        );
        try {
          console.log("coord: doc room joined", id);
          await withTimeout(
            room.waitForReachingServerVersion(),
            `Document room sync (${id})`,
            this.opts.connectionTimeoutMs,
          );
          console.log("coord: doc room version reached", id);

          // Record current local version as dirty target
          const vv = Object.fromEntries(doc.version().toJSON()) as VV;
          if (Object.keys(vv).length > 0) {
            this.journal.markDirty(id, vv);
            // Stay in the room until the server has stored everything this
            // client has (§20). Leaving — and destroying the socket at the
            // end of the round — straight after reaching the *server's*
            // version could drop this client's own update still in flight,
            // and the round would report a sync the server never received.
            await this.waitForDurable(id, vv, httpUrl, hdr);
          }
          count++;
          touched.push(id);
        } finally {
          room.leave();
        }
      } finally { release(); }
    }));

    return count;
  }

  /**
   * Poll the server's durable version for `roomId` until it covers
   * `target`, or give up after the connection timeout. Giving up is not an
   * error: the room stays dirty in the journal and the next round retries.
   */
  private async waitForDurable(
    roomId: string,
    target: VV,
    httpUrl: string,
    hdr: Record<string, string>,
  ): Promise<boolean> {
    const deadline = Date.now() + this.opts.connectionTimeoutMs;
    let delay = 25;
    for (;;) {
      try {
        const res = await fetch(`${httpUrl}/api/durable/${encodeURIComponent(roomId)}`, { headers: hdr });
        if (res.ok) {
          const body = (await res.json()) as { durableVersion: string };
          if (coversVersion(vvFromBase64(body.durableVersion), target)) return true;
        }
      } catch {
        // Network hiccup: fall through to the retry below.
      }
      if (Date.now() + delay > deadline) return false;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 250);
    }
  }

  /* ── binary transfer (bounded concurrency) ─────────────────────── */

  private async syncBinaries(
    ids: string[],
    httpUrl: string,
    hdr: Record<string, string>,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const [acquire, release] = bounded(this.opts.maxConcurrentBinaries);
    let count = 0;

    await Promise.all(ids.map(async (id) => {
      await acquire();
      try {
        const data = await this.hooks.getBinaryData(id);
        if (data) {
          const response = await fetch(`${httpUrl}/api/assets/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { ...hdr, "content-type": "application/octet-stream" },
            body: data.slice().buffer as ArrayBuffer,
          });
          if (response.ok) count++;
          return;
        }
        if (!this.hooks.writeBinaryData) return;
        const response = await fetch(`${httpUrl}/api/assets/${encodeURIComponent(id)}`, {
          headers: hdr,
        });
        if (!response.ok) return;
        await this.hooks.writeBinaryData(id, new Uint8Array(await response.arrayBuffer()));
        count++;
      } finally { release(); }
    }));

    return count;
  }

  /* ── durable poll (exponential backoff, 3 rounds) ───────────────── */

  private async confirmDurables(
    httpUrl: string,
    hdr: Record<string, string>,
  ): Promise<number> {
    let cleared = 0;
    for (let round = 0; round < 3; round++) {
      const pending = this.journal.dirty();
      if (pending.length === 0) break;
      await new Promise((r) => setTimeout(r, 100 * (round + 1)));

      const results = await Promise.allSettled(
        pending.map(async (entry) => {
          const res = await fetch(
            `${httpUrl}/api/durable/${encodeURIComponent(entry.roomId)}`,
            { headers: hdr },
          );
          if (!res.ok) return null;
          const body = await res.json() as { durableVersion: string };
          return { roomId: entry.roomId, vv: vvFromBase64(body.durableVersion) };
        }),
      );

      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value) continue;
        if (this.journal.confirmDurable(r.value.roomId, r.value.vv)) cleared++;
      }
    }
    return cleared;
  }
}
