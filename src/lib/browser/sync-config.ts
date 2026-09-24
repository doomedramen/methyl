import { readRenamedKey } from "@/lib/browser/storage-keys";
import { testWebSocketConnection } from "@/lib/sync/websocket";

/**
 * Local persistence for the browser's sync connection settings (server URL +
 * access token). Kept DOM-free (only touches `localStorage` behind a
 * try/catch, never throws) so it's unit-testable and safe during SSR.
 *
 * NOTE: the access token is stored in plain `localStorage`, readable by any
 * script running on this origin (SPEC §31 describes a cookie-based pairing
 * flow instead — not what this server implements today; see
 * src/server/main.ts / sync-server.ts, which authenticate with a single
 * static bearer token).
 * This matches the server's actual (simpler, self-hosted, LAN-only) auth
 * model, but is a real tradeoff worth knowing about.
 */

/** One sync configuration per vault (spec item 9). */
const storageKey = (vaultId: string) => `methyl.sync-config:${vaultId}`;
/** Before multi-vault: one global configuration, which the default vault inherits. */
const GLOBAL_STORAGE_KEY = "methyl.sync-config";
const LEGACY_STORAGE_KEY = "adhd-sync-config";
const DEFAULT_VAULT_ID = "local";

export interface SyncConfig {
  /** Origin the sync server is reachable at, e.g. "https://methyl.example.com". */
  serverUrl: string;
  authToken: string;
}

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function readConfig(vaultId: string): string | null {
  const key = storageKey(vaultId);
  if (vaultId !== DEFAULT_VAULT_ID) return localStorage.getItem(key);
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const inherited = readRenamedKey(GLOBAL_STORAGE_KEY, LEGACY_STORAGE_KEY);
  if (inherited === null) return null;
  localStorage.setItem(key, inherited);
  localStorage.removeItem(GLOBAL_STORAGE_KEY);
  return inherited;
}

export function loadSyncConfig(vaultId = DEFAULT_VAULT_ID): SyncConfig | null {
  if (!hasLocalStorage()) return null;
  try {
    const raw = readConfig(vaultId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    if (typeof parsed.serverUrl !== "string" || !parsed.serverUrl) return null;
    if (typeof parsed.authToken !== "string" || !parsed.authToken) return null;
    return { serverUrl: parsed.serverUrl, authToken: parsed.authToken };
  } catch {
    return null;
  }
}

export function saveSyncConfig(config: SyncConfig, vaultId = DEFAULT_VAULT_ID): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(storageKey(vaultId), JSON.stringify(config));
  } catch {
    // ignore (private browsing / quota / disabled storage)
  }
}

export function clearSyncConfig(vaultId = DEFAULT_VAULT_ID): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.removeItem(storageKey(vaultId));
    if (vaultId === DEFAULT_VAULT_ID) {
      localStorage.removeItem(GLOBAL_STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

/** Derive the WS + HTTP base URLs the sync client needs from a server origin. */
export function deriveSyncUrls(serverUrl: string): { wsUrl: string; httpUrl: string } {
  const url = new URL(serverUrl);
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    httpUrl: url.origin,
    wsUrl: `${wsProtocol}//${url.host}`,
  };
}

export interface MethylHealth {
  ok: boolean;
}

/** Test the connection: /healthz plus an authenticated call (/api/rooms). */
export async function testSyncConnection(
  config: SyncConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { wsUrl, httpUrl } = deriveSyncUrls(config.serverUrl);
  try {
    const health = await fetch(`${httpUrl}/healthz`);
    if (!health.ok) return { ok: false, error: `Server responded ${health.status} at /healthz` };
    const auth = await fetch(`${httpUrl}/api/rooms`, {
      headers: { authorization: `Bearer ${config.authToken}` },
    });
    if (auth.status === 401) return { ok: false, error: "Access token was rejected" };
    if (!auth.ok) return { ok: false, error: `Server responded ${auth.status} at /api/rooms` };
    try {
      await testWebSocketConnection(wsUrl);
    } catch (err) {
      const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
      return {
        ok: false,
        error:
          "The HTTP API is reachable, but the sync WebSocket could not connect. " +
          "Enable WebSocket upgrade forwarding in the reverse proxy." +
          detail,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
