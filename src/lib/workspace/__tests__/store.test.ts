import { describe, expect, it } from "vitest";
import {
  LocalStorageWorkspacePersistence,
  WorkspaceStore,
  type WorkspacePersistence,
  type WorkspaceSnapshot,
} from "@/lib/workspace/store";

function ids() {
  let n = 0;
  return (prefix: "pane" | "tab" | "split") => `${prefix}-${++n}`;
}

function memoryPersistence(): WorkspacePersistence & { value: WorkspaceSnapshot | null } {
  return {
    value: null,
    load() {
      return this.value;
    },
    save(_vaultId, snapshot) {
      this.value = snapshot;
    },
  };
}

const testLocalStorage = {
  values: new Map<string, string>(),
  getItem(key: string) {
    return this.values.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    this.values.set(key, value);
  },
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: testLocalStorage });

describe("WorkspaceStore", () => {
  it("opens normally by replacing the focused tab and opens explicitly in a new tab", () => {
    const store = new WorkspaceStore({ idFactory: ids() });
    const first = store.open({ kind: "document", documentId: "a" });
    expect(store.getFocusedTab().resource).toEqual({ kind: "document", documentId: "a" });
    const second = store.open({ kind: "document", documentId: "b" });
    expect(second).toBe(first);
    expect(store.getFocusedPane().tabs).toHaveLength(1);
    store.open({ kind: "document", documentId: "a" }, { mode: "new" });
    expect(store.getFocusedPane().tabs).toHaveLength(2);
    store.open({ kind: "document", documentId: "b" }, { mode: "new" });
    expect(store.getFocusedPane().tabs).toHaveLength(2);
    expect(store.getFocusedTab().resource).toEqual({ kind: "document", documentId: "b" });
  });

  it("focuses an existing resource instead of creating duplicates", () => {
    const store = new WorkspaceStore({ idFactory: ids() });
    store.open({ kind: "document", documentId: "a" });
    store.newTab();
    store.open({ kind: "document", documentId: "b" });
    store.open({ kind: "document", documentId: "a" }, { mode: "new" });
    expect(store.getFocusedTab().resource).toEqual({ kind: "document", documentId: "a" });
    expect(store.getFocusedPane().tabs).toHaveLength(2);
  });

  it("splits, moves focus, and collapses a pane without losing tabs", () => {
    const store = new WorkspaceStore({ idFactory: ids() });
    store.open({ kind: "document", documentId: "a" });
    const newPane = store.split();
    store.open({ kind: "document", documentId: "b" });
    expect(store.getSnapshot().root.kind).toBe("split");
    expect(store.getFocusedPane().id).toBe(newPane);
    store.closePane(newPane);
    expect(store.getSnapshot().root.kind).toBe("pane");
    expect(store.getFocusedTab().resource).toEqual({ kind: "document", documentId: "a" });
  });

  it("keeps recent documents bounded and prunes resources", () => {
    const store = new WorkspaceStore({ idFactory: ids() });
    store.open({ kind: "document", documentId: "a" });
    store.open({ kind: "document", documentId: "b" });
    store.open({ kind: "document", documentId: "a" });
    expect(store.getRecentDocumentIds()).toEqual(["a", "b"]);
    store.prune([{ kind: "document", documentId: "a" }]);
    expect(store.getFocusedTab().resource).toEqual({ kind: "document", documentId: "a" });
    expect(store.getRecentDocumentIds()).toEqual(["a"]);
  });

  it("round-trips persisted state and ignores malformed data", () => {
    const persistence = memoryPersistence();
    const first = new WorkspaceStore({ vaultId: "v", persistence, idFactory: ids() });
    first.open({ kind: "document", documentId: "persisted" });
    const second = new WorkspaceStore({ vaultId: "v", persistence, idFactory: ids() });
    expect(second.getFocusedTab().resource).toEqual({ kind: "document", documentId: "persisted" });
    const storage = new LocalStorageWorkspacePersistence("test-workspace");
    testLocalStorage.setItem("test-workspace:v", "{bad");
    expect(storage.load("v")).toBeNull();
  });
});
