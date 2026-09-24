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

/** The server vault a browser vault syncs with when none was chosen (spec item 9). */
export const DEFAULT_REMOTE_VAULT = "default";

export interface SyncConfig {
  /** Origin the sync server is reachable at, e.g. "https://methyl.example.com". */
  serverUrl: string;
  authToken: string;
  /** Which of the server's vaults (a folder under METHYL_VAULTS_PATH) this vault syncs with. */
  remoteVaultId?: string;
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
    const config: SyncConfig = { serverUrl: parsed.serverUrl, authToken: parsed.authToken };
    if (typeof parsed.remoteVaultId === "string" && parsed.remoteVaultId) {
      config.remoteVaultId = parsed.remoteVaultId;
    }
    return config;
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

/**
 * Derive the URLs the sync client needs from a server origin and the server
 * vault to sync with: the HTTP API base (`/api/v/<vaultId>`), the sync
 * WebSocket (`/sync/<vaultId>`), and the origin itself.
 */
export function deriveSyncUrls(
  serverUrl: string,
  remoteVaultId: string = DEFAULT_REMOTE_VAULT,
): { httpUrl: string; apiUrl: string; wsUrl: string } {
  const url = new URL(serverUrl);
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const vault = encodeURIComponent(remoteVaultId);
  return {
    httpUrl: url.origin,
    apiUrl: `${url.origin}/api/v/${vault}`,
    wsUrl: `${wsProtocol}//${url.host}/sync/${vault}`,
  };
}

/** The vaults a server offers, or an error message. */
export async function listServerVaults(
  config: Pick<SyncConfig, "serverUrl" | "authToken">,
): Promise<{ ok: true; vaults: string[] } | { ok: false; error: string }> {
  try {
    const { httpUrl } = deriveSyncUrls(config.serverUrl);
    const res = await fetch(`${httpUrl}/api/vaults`, {
      headers: { authorization: `Bearer ${config.authToken}` },
    });
    if (res.status === 401) return { ok: false, error: "Access token was rejected" };
    if (!res.ok) return { ok: false, error: `Server responded ${res.status} at /api/vaults` };
    const body = (await res.json()) as { vaults?: { id?: unknown }[] };
    const vaults = (body.vaults ?? []).map((v) => v.id).filter((id): id is string => typeof id === "string");
    return { ok: true, vaults };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface MethylHealth {
  ok: boolean;
}

/** Test the connection: /healthz, an authenticated call to the vault's API, and the sync socket. */
export async function testSyncConnection(
  config: SyncConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { wsUrl, httpUrl, apiUrl } = deriveSyncUrls(config.serverUrl, config.remoteVaultId);
  try {
    const health = await fetch(`${httpUrl}/healthz`);
    if (!health.ok) return { ok: false, error: `Server responded ${health.status} at /healthz` };
    const auth = await fetch(`${apiUrl}/rooms`, {
      headers: { authorization: `Bearer ${config.authToken}` },
    });
    if (auth.status === 401) return { ok: false, error: "Access token was rejected" };
    if (auth.status === 404) {
      return { ok: false, error: `The server has no vault named "${config.remoteVaultId ?? DEFAULT_REMOTE_VAULT}"` };
    }
    if (!auth.ok) return { ok: false, error: `Server responded ${auth.status} at ${new URL(apiUrl).pathname}/rooms` };
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
