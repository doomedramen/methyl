import { describe, expect, it } from "vitest";
import {
  buildWorkSet,
  compareVersions,
  coversVersion,
  DirtyJournal,
  mergeVersions,
} from "@/lib/sync/journal";

describe("version vectors", () => {
  it("compares dominated / dominating / concurrent vectors", () => {
    const a = { p1: 3, p2: 1 };
    const b = { p1: 3, p2: 2 };
    expect(compareVersions(a, b)).toBe(-1);
    expect(compareVersions(b, a)).toBe(1);
    expect(compareVersions(a, a)).toBe(0);

    const c = { p1: 5, p2: 0 };
    // incomparable: a is ahead of c on p2, behind on p1
    expect(compareVersions(a, c)).toBe(0);
  });

  it("coversVersion requires every peer in target to be reached", () => {
    expect(coversVersion({ p1: 4 }, { p1: 3 })).toBe(true);
    expect(coversVersion({ p1: 3 }, { p1: 3 })).toBe(true);
    expect(coversVersion({ p1: 2 }, { p1: 3 })).toBe(false);
    expect(coversVersion({ p1: 3 }, { p1: 3, p2: 1 })).toBe(false);
    expect(coversVersion({ p1: 3, p2: 2 }, { p1: 3, p2: 1 })).toBe(true);
  });

  it("merges per-peer maxima", () => {
    expect(mergeVersions({ a: 2 }, { a: 3, b: 1 })).toEqual({ a: 3, b: 1 });
    expect(mergeVersions({ c: 5 }, {})).toEqual({ c: 5 });
  });
});

describe("DirtyJournal", () => {
  it("clears only after the durable version covers the local target", () => {
    const j = new DirtyJournal();
    j.markDirty("doc:1", { p1: 3 });
    j.markDirty("doc:1", { p2: 2 }); // merges into one target
    expect(j.size).toBe(1);

    // server accepted but crashed before persisting: durable version low
    expect(j.confirmDurable("doc:1", { p1: 3 })).toBe(false);
    expect(j.size).toBe(1);

    // server restarted and fixed the gap
    expect(j.confirmDurable("doc:1", { p1: 3, p2: 2 })).toBe(true);
    expect(j.size).toBe(0);
  });

  it("keeps unknown rooms empty and markDirty overwrites/merges", () => {
    const j = new DirtyJournal();
    expect(j.confirmDurable("nope", {})).toBe(false);
    j.markDirty("doc:x", { a: 1 });
    j.markDirty("doc:x", { b: 9 });
    expect(j.get("doc:x")?.targetVersion).toEqual({ a: 1, b: 9 });
  });

  it("sorts dirty output by age", () => {
    const j = new DirtyJournal();
    j.markDirty("doc:old", { a: 1 }, 100);
    j.markDirty("doc:new", { a: 1 }, 300);
    expect(j.dirty().map((d) => d.roomId)).toEqual(["doc:old", "doc:new"]);
  });

  it("snapshot/restore round-trips entries and server seq", () => {
    const j = new DirtyJournal();
    j.markDirty("doc:1", { p: 7 }, 200);
    j.setServerSeq(77);
    const restored = new DirtyJournal(
      j.snapshot().entries,
      j.snapshot().lastServerSeq,
    );
    expect(restored.dirty()).toHaveLength(1);
    expect(restored.getLastServerSeq()).toBe(77);
    expect(restored.get("doc:1")?.targetVersion).toEqual({ p: 7 });
  });

  it("serverSeq only advances forward", () => {
    const j = new DirtyJournal();
    j.setServerSeq(10);
    j.setServerSeq(5);
    expect(j.getLastServerSeq()).toBe(10);
  });
});

describe("buildWorkSet (SPEC §34 step 8)", () => {
  const known = new Set(["doc:a", "doc:b"]);

  it("unions local dirty, server changes, and unknown tree IDs", () => {
    const { documents } = buildWorkSet({
      localDirty: ["doc:x"],
      serverChanged: ["doc:y", "doc:a"], // a is known-synced but changed on server
      treeDocumentIds: ["doc:a", "doc:b", "doc:c"],
      knownSynced: known,
    });
    // server-changed rooms resync even when previously known; only tree
    // discovery skips known-synced IDs
    expect(documents).toEqual(["doc:a", "doc:c", "doc:x", "doc:y"]);
  });

  it("keeps missing binaries out of the document set", () => {
    const { documents, binaries } = buildWorkSet({
      localDirty: [],
      serverChanged: [],
      treeDocumentIds: ["doc:a"],
      knownSynced: known,
      missingBinaries: ["bin:1"],
    });
    expect(documents).toEqual([]);
    expect(binaries).toEqual(["bin:1"]);
  });

  it("bounded by max, documents before binaries", () => {
    const { documents, binaries } = buildWorkSet({
      localDirty: ["doc:1", "doc:2", "doc:3"],
      serverChanged: [],
      treeDocumentIds: [],
      knownSynced: new Set(),
      missingBinaries: ["bin:1", "bin:2"],
      max: 3,
    });
    expect(documents).toEqual(["doc:1", "doc:2", "doc:3"]);
    expect(binaries).toEqual([]);
  });

  it("empty reconnect yields empty work set", () => {
    const { documents, binaries } = buildWorkSet({
      localDirty: [],
      serverChanged: [],
      treeDocumentIds: ["doc:a", "doc:b"],
      knownSynced: known,
    });
    expect(documents).toEqual([]);
    expect(binaries).toEqual([]);
  });
});