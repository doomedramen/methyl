import { LoroWebsocketClient, type LoroWebsocketClientOptions } from "loro-websocket/client";
import { LoroAdaptor } from "loro-adaptors/loro";
import { LoroDoc, VersionVector } from "loro-crdt";
import {
  DirtyJournal,
  buildWorkSet,
  coversVersion,
  type VersionVector as VV,
} from "@/lib/sync/journal";

export interface SyncCoordinatorOptions {
  wsUrl: string;
  httpUrl: string;
  authToken: string;
  vaultId: string;
  maxConcurrentDocs?: number;   // §34: 8 on mobile
  maxConcurrentBinaries?: number; // §34: 2 on mobile
}

export interface SyncReport {
  docsSynced: number;
  binariesSynced: number;
  dirtyCleared: number;
  durationMs: number;
}

export interface SyncHooks {
  getTreeDoc(): LoroDoc;
  getTreeDocumentRoomIds(): string[];
  getSyncedRoomIds(): string[];
  getRoomDoc(roomId: string): Promise<LoroDoc | null>;
  getBinaryData(assetId: string): Promise<Uint8Array | null>;
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

/* ── base64 → VersionVector ─────────────────────────────────────── */

function vvFromBase64(b64: string): VV {
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  return Object.fromEntries(VersionVector.decode(bytes).toJSON()) as VV;
}

/* ── SyncCoordinator ─────────────────────────────────────────────── */

export class SyncCoordinator {
  private readonly opts: Required<Pick<SyncCoordinatorOptions,
    "maxConcurrentDocs" | "maxConcurrentBinaries" >> & SyncCoordinatorOptions;
  private readonly journal: DirtyJournal;
  private readonly hooks: SyncHooks;
  private client: LoroWebsocketClient | null = null;
  private running = false;

  constructor(
    options: SyncCoordinatorOptions,
    journal: DirtyJournal,
    hooks: SyncHooks,
  ) {
    this.opts = { maxConcurrentDocs: 8, maxConcurrentBinaries: 2, ...options };
    this.journal = journal;
    this.hooks = hooks;
  }

  /** Run the §34 reconnect loop. No-op if already running. */
  async sync(): Promise<SyncReport> {
    if (this.running) return { docsSynced: 0, binariesSynced: 0, dirtyCleared: 0, durationMs: 0 };
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
    const client = new LoroWebsocketClient({ url: wsUrl, disablePing: true } as LoroWebsocketClientOptions);
    await client.connect();
    this.client = client;

    // 5-6: join vault tree room, wait for server version
    const treeDoc = this.hooks.getTreeDoc();
    const treeAdaptor = new LoroAdaptor(treeDoc);
    const treeRoom = await client.join({
      roomId: `vault:${vaultId}`,
      crdtAdaptor: treeAdaptor,
      auth: new TextEncoder().encode(authToken),
    });
    await treeRoom.waitForReachingServerVersion();

    // 7: discovery poll
    const lastSeq = this.journal.getLastServerSeq();
    const changesRes = await fetch(`${httpUrl}/api/changes?after=${lastSeq}`, { headers: hdr });
    const { changes: serverChanges } = await changesRes.json() as {
      reset?: boolean;
      changes: Array<{ objectId: string; seq: number }>;
    };

    // 8: build work set
    const knownSynced = new Set(this.hooks.getSyncedRoomIds());
    const { documents, binaries } = buildWorkSet({
      localDirty: this.journal.dirty().map((e) => e.roomId),
      serverChanged: serverChanges.map((c) => c.objectId),
      treeDocumentIds: this.hooks.getTreeDocumentRoomIds(),
      knownSynced,
      missingBinaries: await this.hooks.getMissingBinaryIds(),
    });

    // 9: sync doc rooms
    const docsSynced = await this.syncDocs(documents, client, authToken);

    // 10: sync binaries
    const binariesSynced = await this.syncBinaries(binaries, httpUrl, hdr);

    // 11-12: durable confirm + clear
    const dirtyCleared = await this.confirmDurables(httpUrl, hdr);

    // 13: advance lastServerSeq. Re-poll after sync: rooms we synced (and
    // the tree) have produced new change-log rows, so reflect them now so
    // the next discovery poll skips everything already durably sent.
    const afterRes = await fetch(`${httpUrl}/api/changes?after=${lastSeq}`, { headers: hdr });
    const { changes: afterChanges } = await afterRes.json() as {
      changes: Array<{ objectId: string; seq: number }>;
    };
    if (afterChanges.length > 0) {
      const maxSeq = Math.max(...afterChanges.map((c) => c.seq));
      this.journal.setServerSeq(maxSeq);
    }

    // cleanup
    treeRoom.leave();
    client.destroy();
    this.client = null;

    return { docsSynced, binariesSynced, dirtyCleared, durationMs: 0 };
  }

  /* ── room sync (bounded concurrency) ───────────────────────────── */

  private async syncDocs(
    roomIds: string[],
    client: LoroWebsocketClient,
    authToken: string,
  ): Promise<number> {
    if (roomIds.length === 0) return 0;
    const [acquire, release] = bounded(this.opts.maxConcurrentDocs);
    let count = 0;

    await Promise.all(roomIds.map(async (id) => {
      await acquire();
      try {
        const doc = await this.hooks.getRoomDoc(id);
        if (!doc) return;
        const adaptor = new LoroAdaptor(doc);
        const room = await client.join({
          roomId: id,
          crdtAdaptor: adaptor,
          auth: new TextEncoder().encode(authToken),
        });
        await room.waitForReachingServerVersion();

        // Record current local version as dirty target
        const vv = Object.fromEntries(doc.version().toJSON()) as VV;
        if (Object.keys(vv).length > 0) {
          this.journal.markDirty(id, vv);
        }
        count++;
        room.leave();
      } finally { release(); }
    }));

    return count;
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
        if (!data) return;
        await fetch(`${httpUrl}/api/assets/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { ...hdr, "content-type": "application/octet-stream" },
          body: data.slice().buffer as ArrayBuffer,
        });
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
