import type { VaultFileSystem } from "@/lib/vault/fs";
import { SyncCoordinator, type SyncHooks, type SyncReport } from "@/lib/sync/coordinator";
import { DirtyJournal, type DirtyEntry } from "@/lib/sync/journal";
import type { VaultEngine } from "@/lib/vault/engine";
import { SyncScheduler, type SyncStatus } from "@/lib/sync/scheduler";
import { maybeDropUntouchedSeed } from "@/lib/browser/seed-marker";
import type { TreeID } from "loro-crdt";

const JOURNAL_PATH = ".adhd/sync/journal.json";

export interface JournalSnapshot {
  entries: DirtyEntry[];
  lastServerSeq: number;
}

export interface SyncHostOptions {
  fs: VaultFileSystem;
  engine: VaultEngine;
  wsUrl: string;
  httpUrl: string;
  authToken: string;
  vaultId: string;
  maxConcurrentDocs?: number;
  maxConcurrentBinaries?: number;
  /** Delay between successful sync rounds while running (§34). Default 15s. */
  intervalMs?: number;
}

export type { SyncStatus };

export class SyncHost {
  private readonly fs: VaultFileSystem;
  readonly engine: VaultEngine;
  readonly journal: DirtyJournal;
  private readonly coordinator: SyncCoordinator;
  private readonly scheduler: SyncScheduler;
  private statusListeners = new Set<(status: SyncStatus) => void>();
  private changeListeners = new Set<(report: SyncReport) => void>();
  private lastStatus: SyncStatus = { kind: "idle" };

  private readonly httpUrl: string;
  private readonly authToken: string;

  private constructor(options: SyncHostOptions, journal: DirtyJournal) {
    this.fs = options.fs;
    this.engine = options.engine;
    this.journal = journal;
    this.httpUrl = options.httpUrl;
    this.authToken = options.authToken;
    this.coordinator = new SyncCoordinator(
      {
        wsUrl: options.wsUrl,
        httpUrl: options.httpUrl,
        authToken: options.authToken,
        vaultId: options.vaultId,
        maxConcurrentDocs: options.maxConcurrentDocs,
        maxConcurrentBinaries: options.maxConcurrentBinaries,
        beforeConnect: () =>
          maybeDropUntouchedSeed(this.fs, this.engine, () => this.serverHasContent()),
      },
      journal,
      this.hooks(),
    );
    this.scheduler = new SyncScheduler({
      intervalMs: options.intervalMs,
      run: () => this.sync().then(() => undefined),
      onStatus: (status) => this.emitStatus(status),
    });
  }

  static async create(options: SyncHostOptions): Promise<SyncHost> {
    const journal = await loadJournal(options.fs);
    return new SyncHost(options, journal);
  }

  /** Run one §34 reconnect round: sync, then persist every touched doc/tree so the OPFS store and the on-screen editor (via loro-codemirror's doc.subscribe) both reflect remote changes. */
  async sync(): Promise<SyncReport> {
    const report = await this.coordinator.sync();
    await this.persistJournal();

    if (report.treeTouched) {
      // A remote tree update just merged in — resolve any post-merge
      // same-name sibling collisions (e.g. two devices each seeding their
      // own "welcome.md") as a real tree rename *before* persisting, so
      // the fixed-up name goes out with this same round instead of a
      // later one.
      await this.engine.resolveTreeNameCollisions();
      await this.engine.persistTreeIncremental();
    }
    for (const roomId of report.touchedRoomIds) {
      if (!roomId.startsWith("doc:")) continue;
      const docId = roomId.slice(4);
      try {
        await this.engine.persistDocumentIncremental(docId);
      } catch (err) {
        console.error(`[sync] failed to persist synced doc ${docId}`, err);
      }
    }

    if (report.treeTouched || report.touchedRoomIds.length > 0 || report.binariesSynced > 0) {
      for (const listener of this.changeListeners) listener(report);
    }
    return report;
  }

  /** Start the reconnect/backoff loop (§34). Idempotent. */
  start(): void {
    this.scheduler.start();
  }

  /** Stop the reconnect loop and disconnect any open WS. */
  stop(): void {
    this.scheduler.stop();
    this.disconnect();
    this.emitStatus({ kind: "idle" });
  }

  /** Force an immediate retry, e.g. on `online`/`visibilitychange`. */
  kick(): void {
    this.scheduler.kick();
  }

  get status(): SyncStatus {
    return this.lastStatus;
  }

  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Fires after a round that touched the tree or any doc room — UI should refresh the sidebar tree; the open editor updates itself via loro-codemirror's doc.subscribe. */
  onRemoteChange(listener: (report: SyncReport) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitStatus(status: SyncStatus): void {
    this.lastStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  disconnect(): void {
    this.coordinator.disconnect();
  }

  async persistJournal(): Promise<void> {
    await saveJournal(this.fs, this.journal.snapshot());
  }

  /** Whether the server already has any recorded content for this vault. */
  private async serverHasContent(): Promise<boolean> {
    try {
      const res = await fetch(`${this.httpUrl}/api/changes?after=0`, {
        headers: { authorization: `Bearer ${this.authToken}` },
      });
      if (!res.ok) return false; // can't tell — safest to assume empty and keep the seed
      const body = (await res.json()) as { changes: unknown[] };
      return Array.isArray(body.changes) && body.changes.length > 0;
    } catch {
      return false;
    }
  }

  private hooks(): SyncHooks {
    const engine = this.engine;
    return {
      getTreeDoc: () => engine.tree.doc,
      getTreeDocumentRoomIds: () =>
        engine.tree.documentIds().map((id) => `doc:${id}`),
      getSyncedRoomIds: () => [],
      getRoomDoc: async (roomId: string) => {
        if (!roomId.startsWith("doc:")) return null;
        const docId = roomId.slice(4);
        // A document discovered purely via tree sync (its node arrived,
        // but its own doc room hasn't synced yet) has no local Document
        // instance. ensureDocument() creates the empty landing spot so
        // the incoming room content has somewhere to import into, rather
        // than getRoomDoc returning null and the sync silently dropping
        // that document's content.
        return engine.ensureDocument(docId).doc;
      },
      getBinaryData: async (nodeId: string) =>
        await engine.readAttachment(nodeId as TreeID),
      writeBinaryData: async (nodeId: string, data: Uint8Array) => {
        await engine.writeAttachment(nodeId as TreeID, data);
      },
      getBinaryIds: async () =>
        engine.tree
          .allNodes()
          .filter((node) => node.kind === "binary")
          .map((node) => String(node.treeId)),
      getMissingBinaryIds: async () => {
        const missing: string[] = [];
        for (const node of engine.tree.allNodes()) {
          if (node.kind !== "binary") continue;
          const treeId = `${node.treeId}`;
          if ((await engine.readAttachment(node.treeId)) === null) {
            missing.push(treeId);
          }
        }
        return missing;
      },
    };
  }
}

export async function loadJournal(
  fs: VaultFileSystem,
): Promise<DirtyJournal> {
  const raw = await fs.readTextFile(JOURNAL_PATH);
  if (!raw) return new DirtyJournal();
  try {
    const snapshot = JSON.parse(raw) as JournalSnapshot;
    return new DirtyJournal(snapshot.entries ?? [], snapshot.lastServerSeq ?? 0);
  } catch {
    return new DirtyJournal();
  }
}

export async function saveJournal(
  fs: VaultFileSystem,
  snapshot: JournalSnapshot,
): Promise<void> {
  await fs.mkdir(".adhd/sync");
  await fs.writeTextAtomic(
    JOURNAL_PATH,
    JSON.stringify(snapshot),
  );
}
