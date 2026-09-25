import { readRenamedKey } from "@/lib/browser/storage-keys";
import { testWebSocketConnection } from "@/lib/sync/websocket";

/**
 * The browser's shared sync connection settings and device-pairing calls.
 * Kept DOM-free (only
 * touches `localStorage` behind a try/catch, never throws) so it's
 * unit-testable and safe during SSR.
 *
 * No secret is stored here. The admin token is used once, to pair; the
 * server then keeps this browser signed in with an HttpOnly cookie that
 * scripts can't read. Configs saved before pairing existed still hold the
 * admin token (`authToken`); sync-context pairs with it once and drops it.
 */

/** Pre shared-sync, each vault kept its own server URL and remote ID. */
const storageKey = (vaultId: string) => `methyl.sync-config:${vaultId}`;
/** One server connection now covers every vault on this browser origin. */
const GLOBAL_STORAGE_KEY = "methyl.sync-config";
const LEGACY_STORAGE_KEY = "adhd-sync-config";
const DEFAULT_VAULT_ID = "local";

/** Compatibility ID used by older clients and default-vault migration. */
export const DEFAULT_REMOTE_VAULT = "default";

export interface SyncConfig {
  /** Origin the sync server is reachable at, e.g. "https://methyl.example.com". */
  serverUrl: string;
  /** Only in configs from before device pairing: the admin token, migrated away on load. */
  authToken?: string;
  /** Read only for migration from the old per-vault setup. */
  remoteVaultId?: string;
}

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function storageKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function parseConfig(raw: string | null): SyncConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    if (typeof parsed.serverUrl !== "string" || !parsed.serverUrl) return null;
    const config: SyncConfig = { serverUrl: parsed.serverUrl };
    if (typeof parsed.authToken === "string" && parsed.authToken) config.authToken = parsed.authToken;
    if (typeof parsed.remoteVaultId === "string" && parsed.remoteVaultId) config.remoteVaultId = parsed.remoteVaultId;
    return config;
  } catch {
    return null;
  }
}

export function loadSyncConfig(vaultId = DEFAULT_VAULT_ID): SyncConfig | null {
  if (!hasLocalStorage()) return null;
  try {
    const shared = parseConfig(readRenamedKey(GLOBAL_STORAGE_KEY, LEGACY_STORAGE_KEY));
    if (shared) return shared;
    const local = parseConfig(localStorage.getItem(storageKey(vaultId)));
    if (local) return local;
    // Existing installations may have configured only a non-default vault.
    for (const key of storageKeys()) {
      if (!key.startsWith("methyl.sync-config:") || key === storageKey(vaultId)) continue;
      const found = parseConfig(localStorage.getItem(key));
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  }
}

/** Old server-folder choices become stable IDs on their matching local vaults. */
export function loadLegacyVaultSyncIds(): Record<string, string> {
  if (!hasLocalStorage()) return {};
  const result: Record<string, string> = {};
  try {
    const oldGlobal = parseConfig(readRenamedKey(GLOBAL_STORAGE_KEY, LEGACY_STORAGE_KEY));
    if (oldGlobal?.remoteVaultId) result[DEFAULT_VAULT_ID] = oldGlobal.remoteVaultId;
    for (const key of storageKeys()) {
      if (!key.startsWith("methyl.sync-config:")) continue;
      const localVaultId = key.slice("methyl.sync-config:".length);
      const config = parseConfig(localStorage.getItem(key));
      if (localVaultId && config?.remoteVaultId) result[localVaultId] = config.remoteVaultId;
    }
  } catch {
    // Private browsing may deny storage access.
  }
  return result;
}

export function saveSyncConfig(config: SyncConfig, _vaultId = DEFAULT_VAULT_ID): void {
  if (!hasLocalStorage()) return;
  try {
    const { serverUrl, authToken } = config;
    const oldGlobal = parseConfig(readRenamedKey(GLOBAL_STORAGE_KEY, LEGACY_STORAGE_KEY));
    if (oldGlobal?.remoteVaultId) {
      const localKey = storageKey(DEFAULT_VAULT_ID);
      const oldLocal = parseConfig(localStorage.getItem(localKey));
      if (!oldLocal?.remoteVaultId) {
        localStorage.setItem(localKey, JSON.stringify({
          serverUrl: oldLocal?.serverUrl ?? oldGlobal.serverUrl,
          remoteVaultId: oldGlobal.remoteVaultId,
        }));
      }
    }
    localStorage.setItem(GLOBAL_STORAGE_KEY, JSON.stringify({ serverUrl, ...(authToken ? { authToken } : {}) }));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    // Remove old per-vault admin tokens while retaining their server IDs
    // until the registry migration has copied those IDs into vaults.json.
    for (const key of storageKeys()) {
      if (!key.startsWith("methyl.sync-config:")) continue;
      const legacy = parseConfig(localStorage.getItem(key));
      if (!legacy?.authToken) continue;
      localStorage.setItem(key, JSON.stringify({
        serverUrl: legacy.serverUrl,
        ...(legacy.remoteVaultId ? { remoteVaultId: legacy.remoteVaultId } : {}),
      }));
    }
  } catch {
    // ignore (private browsing / quota / disabled storage)
  }
}

export function clearSyncConfig(_vaultId = DEFAULT_VAULT_ID): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.removeItem(GLOBAL_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    for (const key of storageKeys()) {
      if (key.startsWith("methyl.sync-config:")) localStorage.removeItem(key);
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

function bearer(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** The vaults a server offers this browser, or an error message. */
export async function listServerVaults(
  config: Pick<SyncConfig, "serverUrl" | "authToken">,
): Promise<{ ok: true; vaults: string[] } | { ok: false; error: string }> {
  try {
    const { httpUrl } = deriveSyncUrls(config.serverUrl);
    const res = await fetch(`${httpUrl}/api/vaults`, { headers: bearer(config.authToken), credentials: "same-origin" });
    if (res.status === 401) return { ok: false, error: "Not paired with this server" };
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
  /** The server's version (spec item 12); absent on servers before it. */
  version?: string;
}

/** The server's version from /healthz, or null if unreachable or not reported. */
export async function fetchServerVersion(serverUrl: string): Promise<string | null> {
  try {
    const { httpUrl } = deriveSyncUrls(serverUrl);
    const res = await fetch(`${httpUrl}/healthz`);
    if (!res.ok) return null;
    const body = (await res.json()) as MethylHealth;
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** Test health and pairing; test WebSocket forwarding when server has a vault. */
export async function testSyncConnection(
  config: SyncConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { httpUrl } = deriveSyncUrls(config.serverUrl);
  try {
    const health = await fetch(`${httpUrl}/healthz`);
    if (!health.ok) return { ok: false, error: `Server responded ${health.status} at /healthz` };
    const listed = await listServerVaults(config);
    if (!listed.ok) return listed;
    const firstVault = listed.vaults[0];
    if (firstVault) {
      const { wsUrl } = deriveSyncUrls(config.serverUrl, firstVault);
      try {
        await testWebSocketConnection(wsUrl);
      } catch (err) {
        const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
        return {
          ok: false,
          error: "The HTTP API is reachable, but the sync WebSocket could not connect. Enable WebSocket upgrade forwarding in the reverse proxy." + detail,
        };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ── device pairing (spec item 5) ─────────────────────────────────── */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface PairedDevice {
  id: string;
  name: string;
  vaults: "*" | string[];
  createdAt: number;
  lastSeenAt: number | null;
  current?: boolean;
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // not JSON
  }
  return `Server responded ${res.status}`;
}

/** Create one server folder through a wildcard-paired browser cookie. */
export async function ensureServerVault(options: { serverUrl: string; id: string }): Promise<Result<{ id: string }>> {
  try {
    const { httpUrl } = deriveSyncUrls(options.serverUrl);
    const res = await fetch(`${httpUrl}/api/vaults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: options.id }),
      credentials: "same-origin",
    });
    if (res.ok) return { ok: true, id: options.id };
    if (res.status === 409) {
      const listed = await listServerVaults({ serverUrl: options.serverUrl });
      if (listed.ok && listed.vaults.includes(options.id)) return { ok: true, id: options.id };
    }
    return { ok: false, error: await errorOf(res) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A readable name for this browser, e.g. "Safari on iPhone". */
export function describeThisDevice(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const ua = userAgent;
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const platform = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return platform ? `${browser} on ${platform}` : browser;
}

/**
 * Pair this browser with the server using its admin token. The server sets
 * the device cookie; the token itself is not kept. Pairing again from a
 * paired browser adds the vault to the same device.
 */
export async function pairDevice(options: {
  serverUrl: string;
  adminToken: string;
  deviceName?: string;
}): Promise<Result<{ device: PairedDevice }>> {
  try {
    const { httpUrl } = deriveSyncUrls(options.serverUrl);
    const res = await fetch(`${httpUrl}/api/auth/pair`, {
      method: "POST",
      headers: { ...bearer(options.adminToken), "content-type": "application/json" },
      body: JSON.stringify({
        deviceName: options.deviceName ?? describeThisDevice(),
        vaults: "*",
      }),
    });
    if (res.status === 401) return { ok: false, error: "The admin token was rejected" };
    if (!res.ok) return { ok: false, error: await errorOf(res) };
    const body = (await res.json()) as { device: PairedDevice };
    return { ok: true, device: body.device };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Is this browser paired, and for which of the server's vaults? */
export async function getPairing(serverUrl: string): Promise<
  { paired: true; device: PairedDevice; vaults: string[] } | { paired: false; error?: string }
> {
  try {
    const { httpUrl } = deriveSyncUrls(serverUrl);
    const res = await fetch(`${httpUrl}/api/auth/me`);
    if (res.status === 401) return { paired: false };
    if (!res.ok) return { paired: false, error: await errorOf(res) };
    const body = (await res.json()) as { kind: string; device?: PairedDevice; vaults?: string[] };
    if (body.kind !== "device" || !body.device) return { paired: false };
    return { paired: true, device: body.device, vaults: body.vaults ?? [] };
  } catch (err) {
    return { paired: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A single-use sync ticket for one round's socket. Throws when refused. */
export async function fetchSyncTicket(serverUrl: string, remoteVaultId = DEFAULT_REMOTE_VAULT): Promise<string> {
  const { httpUrl } = deriveSyncUrls(serverUrl);
  const res = await fetch(`${httpUrl}/api/auth/ws-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vault: remoteVaultId }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401 ? "This browser isn't paired with the server any more; pair it again in Sync settings."
        : res.status === 403 ? `This browser isn't paired for the server vault "${remoteVaultId}".`
        : await errorOf(res),
    );
  }
  return ((await res.json()) as { ticket: string }).ticket;
}

/** Paired devices; with the admin token, any of them can be removed. */
export async function listDevices(serverUrl: string, adminToken?: string): Promise<Result<{ devices: PairedDevice[] }>> {
  try {
    const { httpUrl } = deriveSyncUrls(serverUrl);
    const res = await fetch(`${httpUrl}/api/auth/devices`, { headers: bearer(adminToken) });
    if (!res.ok) return { ok: false, error: await errorOf(res) };
    return { ok: true, devices: ((await res.json()) as { devices: PairedDevice[] }).devices };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a device: this browser itself, or (with the admin token) any other. */
export async function removeDevice(serverUrl: string, id: string, adminToken?: string): Promise<Result> {
  try {
    const { httpUrl } = deriveSyncUrls(serverUrl);
    const res = await fetch(`${httpUrl}/api/auth/devices/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: bearer(adminToken),
    });
    if (!res.ok) return { ok: false, error: await errorOf(res) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
