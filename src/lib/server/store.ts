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
    | { roomId: string; durableVersion: Buffer | null; serverSeq: number }
    | undefined {
    return this.db
      .prepare("SELECT roomId, durableVersion, serverSeq FROM rooms WHERE roomId = ?")
      .get(roomId) as any;
  }

  upsertRoom(
    roomId: string,
    crdtType: string,
    durableVersion: Buffer,
    serverSeq: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO rooms (roomId, crdtType, durableVersion, serverSeq, lastSaved)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(roomId) DO UPDATE SET
           durableVersion = excluded.durableVersion,
           serverSeq = excluded.serverSeq,
           lastSaved = excluded.lastSaved`,
      )
      .run(roomId, crdtType, durableVersion, serverSeq, Date.now());
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
    if (afterSeq < minRetained) {
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
}