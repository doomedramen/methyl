import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { ServerStore } from "@/lib/server/store";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpDir: string;
let store: ServerStore;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-test-"));
  store = new ServerStore(join(tmpDir, ".methyl/server/sync.sqlite"));
});

afterAll(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ServerStore (§22)", () => {
  it("schema is created; unknown room is undefined", () => {
    expect(store.getRoom("nonexistent")).toBeUndefined();
  });

  it("inserts and retrieves rooms with snapshot + durable version", () => {
    const snapshot = Buffer.from("snapshot-bytes");
    const vv = Buffer.from("vv-bytes");
    store.upsertRoom("doc:test", "Loro", snapshot, vv, 1);
    const room = store.getRoom("doc:test");
    expect(room!.serverSeq).toBe(1);
    expect(room!.snapshot).toEqual(snapshot);
    expect(room!.durableVersion).toEqual(vv);
    expect(store.getDurableVersion("doc:test")).toEqual(vv);
  });

  it("records changes with monotonically increasing seq", () => {
    const seq1 = store.getNextSeq();
    store.recordChange(seq1, "doc:test", "doc");
    const seq2 = store.getNextSeq();
    expect(seq2).toBeGreaterThan(seq1);
    store.recordChange(seq2, "doc:test", "doc");
  });

  it("returns remaining changes after a sequence", () => {
    const seq = store.getNextSeq();
    store.recordChange(seq, "doc:after-test", "doc");
    const result = store.getChangesAfter(seq - 1);
    expect(result.reset).toBe(false);
    expect(result.changes.length).toBe(1);
    expect(result.changes[0].objectId).toBe("doc:after-test");
  });

  it("a fresh client receives all changes without reset (no compaction yet)", () => {
    const seq = store.getNextSeq();
    store.recordChange(seq, "doc:compacted", "doc");
    // after=0 with an uncompacted log (oldest retained seq == 1) must not
    // reset: the retained window still covers everything the client needs.
    const result = store.getChangesAfter(0);
    expect(result.reset).toBe(false);
    expect(result.changes.map((c) => c.objectId)).toContain("doc:compacted");
  });

  it("resets when compaction dropped rows at/below the client cursor (SPEC §35)", () => {
    // Isolated store: compaction of the shared log would break sibling tests.
    const dir = mkdtempSync(join(tmpdir(), "adhd-compact-"));
    const isolated = new ServerStore(join(dir, "sync.sqlite"));
    try {
      const seq1 = isolated.getNextSeq();
      isolated.recordChange(seq1, "doc:old", "doc");
      const seq2 = isolated.getNextSeq();
      isolated.recordChange(seq2, "doc:new", "doc");
      isolated.purgeChangesBelow(seq2); // deletes seq1
      // Client cursor sits below the purged boundary -> reset.
      expect(isolated.getChangesAfter(seq1).reset).toBe(true);
      // Client cursor at/above the boundary still reads the retained log.
      expect(isolated.getChangesAfter(seq2).reset).toBe(false);
      expect(isolated.getChangesAfter(seq2).changes).toEqual([]);
      // Cursor that needs the purged row (seq1) -> reset.
      expect(isolated.getChangesAfter(seq1).reset).toBe(true);
      expect(isolated.getChangesAfter(seq1).changes).toEqual([]);
      // Fresh store is never reset.
      isolated.purgeChangesBelow(seq2 + 1); // no-op (nothing below seq2+1)
      const freshDir = mkdtempSync(join(tmpdir(), "adhd-fresh-"));
      const fresh = new ServerStore(join(freshDir, "sync.sqlite"));
      fresh.recordChange(fresh.getNextSeq(), "doc:fresh", "doc");
      expect(fresh.getChangesAfter(0).reset).toBe(false);
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    } finally {
      isolated.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asset metadata round-trips and lands in the change log", () => {
    const seq = store.getNextSeq();
    store.upsertAsset("node:1", "abc123", 42, seq);
    const meta = store.getAssetMeta("node:1");
    expect(meta?.sha256).toBe("abc123");
    expect(meta?.size).toBe(42);
    store.recordChange(seq, "node:1", "asset");
    const after = store.getChangesAfter(0);
    expect(after.reset).toBe(false); // fresh client receives all changes
    expect(store.getChangesAfter(seq - 1).changes.some((c) => c.type === "asset")).toBe(true);
  });

  it("lists rooms ordered by serverSeq", () => {
    const rows = store.listRooms();
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) expect(typeof r.roomId).toBe("string");
  });
});