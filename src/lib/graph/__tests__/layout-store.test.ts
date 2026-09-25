import { describe, it, expect } from "vitest";
import type { PersistedDocStore } from "@/lib/vault/store";
import type { PersistedDocState } from "@/lib/core/types";
import { readGraphLayout, writeGraphLayout, deleteGraphLayout } from "@/lib/graph/layout-store";

/** Minimal in-memory PersistedDocStore fake — only the materialized-file
 * half is used by layout-store.ts. */
function fakeStore(): PersistedDocStore {
  const files = new Map<string, Uint8Array>();
  return {
    async listDocumentIds() {
      return [];
    },
    async loadSnapshot() {
      return null;
    },
    async loadUpdates() {
      return [];
    },
    async appendUpdate() {},
    async compact() {},
    async readState(): Promise<PersistedDocState | null> {
      return null;
    },
    async readMaterialized(path: string) {
      return files.get(path) ?? null;
    },
    async writeMaterializedAtomic(path: string, bytes: Uint8Array) {
      files.set(path, bytes);
    },
    async listMaterializedPaths() {
      return Array.from(files.keys());
    },
    async removeMaterialized(path: string) {
      files.delete(path);
    },
    async removeEmptyMaterializedDirectories() {},
  };
}

describe("graph layout store", () => {
  it("returns null when nothing has been saved", async () => {
    const store = fakeStore();
    expect(await readGraphLayout(store, "doc-1")).toBeNull();
  });

  it("writes and reads back a layout", async () => {
    const store = fakeStore();
    await writeGraphLayout(store, "doc-1", {
      nodes: { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } },
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(await readGraphLayout(store, "doc-1")).toEqual({
      nodes: { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } },
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it("keeps layouts for different documents separate", async () => {
    const store = fakeStore();
    await writeGraphLayout(store, "doc-1", { nodes: { a: { x: 1, y: 1 } } });
    await writeGraphLayout(store, "doc-2", { nodes: { a: { x: 2, y: 2 } } });
    expect(await readGraphLayout(store, "doc-1")).toEqual({ nodes: { a: { x: 1, y: 1 } } });
    expect(await readGraphLayout(store, "doc-2")).toEqual({ nodes: { a: { x: 2, y: 2 } } });
  });

  it("deletes a layout without disturbing others", async () => {
    const store = fakeStore();
    await writeGraphLayout(store, "doc-1", { nodes: { a: { x: 1, y: 1 } } });
    await writeGraphLayout(store, "doc-2", { nodes: { a: { x: 2, y: 2 } } });
    await deleteGraphLayout(store, "doc-1");
    expect(await readGraphLayout(store, "doc-1")).toBeNull();
    expect(await readGraphLayout(store, "doc-2")).toEqual({ nodes: { a: { x: 2, y: 2 } } });
  });

  it("deleting an unknown document is a no-op", async () => {
    const store = fakeStore();
    await expect(deleteGraphLayout(store, "nope")).resolves.toBeUndefined();
  });
});
