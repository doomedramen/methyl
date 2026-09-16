import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  roomId TEXT PRIMARY KEY,
  crdtType TEXT NOT NULL DEFAULT 'Loro',
  durableVersion BLOB,
  snapshot BLOB,
  serverSeq INTEGER NOT NULL DEFAULT 0,
  lastSaved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assets (
  nodeId TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  serverSeq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY,
  objectId TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('doc', 'asset', 'tree')),
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_changes_object ON changes(objectId);
`;

export class ServerStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run("schema_version", String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  getNextSeq(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM changes")
      .get() as { next: number };
    return row.next;
  }

  getRoom(roomId: string):
    | {
        roomId: string;
        durableVersion: Buffer | null;
        snapshot: Buffer | null;
        serverSeq: number;
      }
    | undefined {
    return this.db
      .prepare(
        "SELECT roomId, durableVersion, snapshot, serverSeq FROM rooms WHERE roomId = ?",
      )
      .get(roomId) as any;
  }

  upsertRoom(
    roomId: string,
    crdtType: string,
    snapshot: Buffer,
    durableVersion: Buffer,
    serverSeq: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO rooms (roomId, crdtType, durableVersion, snapshot, serverSeq, lastSaved)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(roomId) DO UPDATE SET
           durableVersion = excluded.durableVersion,
           snapshot = excluded.snapshot,
           serverSeq = excluded.serverSeq,
           lastSaved = excluded.lastSaved`,
      )
      .run(roomId, crdtType, durableVersion, snapshot, serverSeq, Date.now());
  }

  recordChange(
    seq: number,
    objectId: string,
    type: "doc" | "asset" | "tree",
  ): void {
    this.db
      .prepare(
        "INSERT INTO changes (seq, objectId, type, timestamp) VALUES (?, ?, ?, ?)",
      )
      .run(seq, objectId, type, Date.now());
  }

  getChangesAfter(afterSeq: number): {
    reset: boolean;
    changes: { seq: number; objectId: string; type: string; timestamp: number }[];
    minRetainedSeq: number;
  } {
    const row = this.db
      .prepare("SELECT MIN(seq) AS minSeq FROM changes")
      .get() as { minSeq: number | null };
    const minRetained = row.minSeq ?? 0;
    // Reset only when compaction has actually deleted rows the client still
    // needs: client asks for changes > afterSeq, and rows <= droppedBelow
    // have been purged. A fresh client (afterSeq=0) on an uncompacted log
    // (droppedBelow=0) still receives all changes.
    const droppedBelow = this.getDroppedBelow();
    if (afterSeq < droppedBelow) {
      return { reset: true, changes: [], minRetainedSeq: minRetained };
    }
    const changes = this.db
      .prepare("SELECT seq, objectId, type, timestamp FROM changes WHERE seq > ? ORDER BY seq")
      .all(afterSeq) as any[];
    return { reset: false, changes, minRetainedSeq: minRetained };
  }

  getDurableVersion(roomId: string): Buffer | null {
    const row = this.getRoom(roomId);
    return row?.durableVersion ?? null;
  }

  /** Compact the change log (SPEC §35): drop rows below `minSeq`. */
  purgeChangesBelow(minSeq: number): number {
    const res = this.db
      .prepare("DELETE FROM changes WHERE seq < ?")
      .run(minSeq);
    if (res.changes > 0) {
      // Track the highest seq boundary we have actually deleted rows below.
      // A client asking `after` < this needs full rediscovery.
      const prev = Number(
        (this.db.prepare("SELECT value FROM meta WHERE key = 'dropped_below'").get() as
          | { value: string }
          | undefined)?.value ?? 0,
      );
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('dropped_below', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(Math.max(prev, minSeq)));
    }
    return res.changes;
  }

  /** Highest change-log seq below which rows have been purged. */
  getDroppedBelow(): number {
    return Number(
      (this.db.prepare("SELECT value FROM meta WHERE key = 'dropped_below'").get() as
        | { value: string }
        | undefined)?.value ?? 0,
    );
  }

  listRooms(): {
    roomId: string;
    crdtType: string;
    serverSeq: number;
    lastSaved: number;
  }[] {
    return this.db
      .prepare(
        "SELECT roomId, crdtType, serverSeq, lastSaved FROM rooms ORDER BY serverSeq",
      )
      .all() as any[];
  }

  /** Record asset discovery metadata. Returns the newly allocated serverSeq. */
  upsertAsset(
    nodeId: string,
    sha256: string,
    size: number,
    serverSeq: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO assets (nodeId, sha256, size, serverSeq)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(nodeId) DO UPDATE SET
           sha256 = excluded.sha256,
           size = excluded.size,
           serverSeq = excluded.serverSeq`,
      )
      .run(nodeId, sha256, size, serverSeq);
  }

  getAssetMeta(nodeId: string):
    | { nodeId: string; sha256: string; size: number; serverSeq: number }
    | undefined {
    return this.db
      .prepare("SELECT nodeId, sha256, size, serverSeq FROM assets WHERE nodeId = ?")
      .get(nodeId) as any;
  }
}