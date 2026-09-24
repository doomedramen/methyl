import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The vitest environment is plain Node ("environment: node" in
// vitest.config.ts, so the CRDT/WASM-heavy tests elsewhere stay fast) —
// there's no global `localStorage`. sync-config.ts's own hasLocalStorage()
// guard needs a real (if minimal) implementation to exercise, not just the
// "storage unavailable" fallback path.
class MemoryLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}
(globalThis as unknown as { localStorage: MemoryLocalStorage }).localStorage = new MemoryLocalStorage();

import {
  loadSyncConfig,
  saveSyncConfig,
  clearSyncConfig,
  deriveSyncUrls,
  testSyncConnection,
} from "@/lib/browser/sync-config";
import { shouldSeedWelcomeNote } from "@/lib/browser/vault";

class TestWebSocket {
  static outcome: "open" | "error" = "open";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    queueMicrotask(() => {
      if (TestWebSocket.outcome === "open") this.onopen?.();
      else this.onerror?.();
    });
  }

  close(): void {
    this.onclose?.();
  }
}

describe("sync config store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestWebSocket.outcome = "open";
  });

  it("returns null when nothing is saved", () => {
    expect(loadSyncConfig()).toBeNull();
  });

  it("round-trips a saved config", () => {
    saveSyncConfig({ serverUrl: "https://adhd.example.com", authToken: "secret-token" });
    expect(loadSyncConfig()).toEqual({
      serverUrl: "https://adhd.example.com",
      authToken: "secret-token",
    });
  });

  it("clears the saved config", () => {
    saveSyncConfig({ serverUrl: "https://adhd.example.com", authToken: "secret-token" });
    clearSyncConfig();
    expect(loadSyncConfig()).toBeNull();
  });

  it("rejects malformed JSON", () => {
    localStorage.setItem("adhd-sync-config", "{not json");
    expect(loadSyncConfig()).toBeNull();
  });

  it("rejects a config missing fields", () => {
    localStorage.setItem("adhd-sync-config", JSON.stringify({ serverUrl: "https://x.example.com" }));
    expect(loadSyncConfig()).toBeNull();
  });

  it("derives ws/http urls from an https origin", () => {
    expect(deriveSyncUrls("https://adhd.example.com/some/path?x=1")).toEqual({
      httpUrl: "https://adhd.example.com",
      apiUrl: "https://adhd.example.com/api/v/default",
      wsUrl: "wss://adhd.example.com/sync/default",
    });
  });

  it("derives ws/http urls from an http origin with a port", () => {
    expect(deriveSyncUrls("http://localhost:8090", "work")).toEqual({
      httpUrl: "http://localhost:8090",
      apiUrl: "http://localhost:8090/api/v/work",
      wsUrl: "ws://localhost:8090/sync/work",
    });
  });

  it("checks the WebSocket transport, not only the HTTP API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    TestWebSocket.outcome = "error";
    vi.stubGlobal("WebSocket", TestWebSocket);

    const result = await testSyncConnection({
      serverUrl: "https://adhd.example.com",
      authToken: "secret-token",
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining("WebSocket could not connect"),
    });
  });

  it("accepts a server when both HTTP and WebSocket transports work", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    vi.stubGlobal("WebSocket", TestWebSocket);

    await expect(
      testSyncConnection({
        serverUrl: "https://adhd.example.com",
        authToken: "secret-token",
      }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("shouldSeedWelcomeNote (fresh-vault welcome-note seed gate)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("seeds when no sync server is configured", () => {
    expect(shouldSeedWelcomeNote()).toBe(true);
  });

  it("does not seed once a sync server is configured — a fresh vault is about to receive its peer's notes, and seeding independently would race a duplicate 'Welcome' note into the merge", () => {
    saveSyncConfig({ serverUrl: "https://adhd.example.com", authToken: "t" });
    expect(shouldSeedWelcomeNote()).toBe(false);
  });

  it("resumes seeding after disconnecting", () => {
    saveSyncConfig({ serverUrl: "https://adhd.example.com", authToken: "t" });
    clearSyncConfig();
    expect(shouldSeedWelcomeNote()).toBe(true);
  });
});
