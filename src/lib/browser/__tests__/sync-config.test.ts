import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The vitest environment is plain Node ("environment: node" in
// vitest.config.ts, so the CRDT/WASM-heavy tests elsewhere stay fast) —
// there's no global `localStorage`. sync-config.ts's own hasLocalStorage()
// guard needs a real (if minimal) implementation to exercise, not just the
// "storage unavailable" fallback path.
class MemoryLocalStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
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
  describeThisDevice,
  loadLegacyVaultSyncIds,
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

  it("rejects a config without a server URL", () => {
    localStorage.setItem("adhd-sync-config", JSON.stringify({ authToken: "t" }));
    expect(loadSyncConfig()).toBeNull();
  });

  it("a paired config holds no token; an old one still yields its token for migration", () => {
    localStorage.setItem("methyl.sync-config:local", JSON.stringify({ serverUrl: "https://x.example.com", remoteVaultId: "work" }));
    expect(loadSyncConfig()).toEqual({ serverUrl: "https://x.example.com", remoteVaultId: "work" });
    localStorage.setItem("methyl.sync-config:local", JSON.stringify({ serverUrl: "https://x.example.com", authToken: "old" }));
    expect(loadSyncConfig()).toEqual({ serverUrl: "https://x.example.com", authToken: "old" });
  });

  it("shares server config across vaults and strips old per-vault admin tokens", () => {
    localStorage.setItem("methyl.sync-config:local", JSON.stringify({
      serverUrl: "https://old.example.com",
      authToken: "old-token",
      remoteVaultId: "legacy-default",
    }));
    saveSyncConfig({ serverUrl: "https://new.example.com" });

    expect(loadSyncConfig("another-vault")).toEqual({ serverUrl: "https://new.example.com" });
    expect(loadLegacyVaultSyncIds()).toEqual({ local: "legacy-default" });
    expect(localStorage.getItem("methyl.sync-config:local")).not.toContain("old-token");
  });

  it("names this device from the user agent", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(describeThisDevice(iphone)).toBe("Safari on iPhone");
    const chromeWin = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
    expect(describeThisDevice(chromeWin)).toBe("Chrome on Windows");
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

  it("checks WebSocket forwarding when at least one server vault exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => String(input).endsWith("/api/vaults") ? { vaults: [{ id: "personal" }] } : { ok: true },
    })));
    TestWebSocket.outcome = "error";
    vi.stubGlobal("WebSocket", TestWebSocket);

    const result = await testSyncConnection({ serverUrl: "https://adhd.example.com", authToken: "secret-token" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("WebSocket could not connect") });
  });

  it("accepts an authenticated server before it has any vault folders", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => String(input).endsWith("/api/vaults") ? { vaults: [] } : { ok: true },
    })));
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
