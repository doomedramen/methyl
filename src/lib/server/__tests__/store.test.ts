import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { ServerStore } from "@/lib/server/store";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpDir: string;
let store: ServerStore;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adhd-test-"));
  store = new ServerStore(join(tmpDir, ".adhd/server/sync.sqlite"));
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

  it("returns reset when a client asks below retained history (SPEC §35)", () => {
    const seq = store.getNextSeq();
    store.recordChange(seq, "doc:compacted", "doc");
    // Any seq below the oldest retained row forces full rediscovery.
    const result = store.getChangesAfter(0);
    expect(result.reset).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("asset metadata round-trips and lands in the change log", () => {
    const seq = store.getNextSeq();
    store.upsertAsset("node:1", "abc123", 42, seq);
    const meta = store.getAssetMeta("node:1");
    expect(meta?.sha256).toBe("abc123");
    expect(meta?.size).toBe(42);
    store.recordChange(seq, "node:1", "asset");
    const after = store.getChangesAfter(0);
    expect(after.reset).toBe(true); // fresh client always full-discovers
    expect(store.getChangesAfter(seq - 1).changes.some((c) => c.type === "asset")).toBe(true);
  });

  it("lists rooms ordered by serverSeq", () => {
    const rows = store.listRooms();
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) expect(typeof r.roomId).toBe("string");
  });
});