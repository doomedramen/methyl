import type { VaultFileSystem } from "@/lib/vault/fs";
import { SyncCoordinator, type SyncHooks } from "@/lib/sync/coordinator";
import { DirtyJournal, type DirtyEntry } from "@/lib/sync/journal";
import type { VaultEngine } from "@/lib/vault/engine";

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
}

export class SyncHost {
  private readonly fs: VaultFileSystem;
  readonly engine: VaultEngine;
  readonly journal: DirtyJournal;
  private readonly coordinator: SyncCoordinator;

  private constructor(options: SyncHostOptions, journal: DirtyJournal) {
    this.fs = options.fs;
    this.engine = options.engine;
    this.journal = journal;
    this.coordinator = new SyncCoordinator(
      {
        wsUrl: options.wsUrl,
        httpUrl: options.httpUrl,
        authToken: options.authToken,
        vaultId: options.vaultId,
        maxConcurrentDocs: options.maxConcurrentDocs,
        maxConcurrentBinaries: options.maxConcurrentBinaries,
      },
      journal,
      this.hooks(),
    );
  }

  static async create(options: SyncHostOptions): Promise<SyncHost> {
    const journal = await loadJournal(options.fs);
    return new SyncHost(options, journal);
  }

  sync(): ReturnType<SyncCoordinator["sync"]> {
    return this.coordinator.sync().then(async (report) => {
      await this.persistJournal();
      return report;
    });
  }

  disconnect(): void {
    this.coordinator.disconnect();
  }

  async persistJournal(): Promise<void> {
    await saveJournal(this.fs, this.journal.snapshot());
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
        const doc = engine.getDocument(docId);
        return doc ? doc.doc : null;
      },
      getBinaryData: async (nodeId: string) =>
        (await this.fs.readFile(assetPath(nodeId))) ?? null,
      getMissingBinaryIds: async () => {
        const missing: string[] = [];
        for (const node of engine.tree.allNodes()) {
          if (node.kind !== "binary") continue;
          const treeId = `${node.treeId}`;
          if ((await this.fs.exists(assetPath(treeId))) === false) {
            missing.push(treeId);
          }
        }
        return missing;
      },
    };
  }
}

function assetPath(nodeId: string): string {
  return `.adhd/assets/${nodeId}`;
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