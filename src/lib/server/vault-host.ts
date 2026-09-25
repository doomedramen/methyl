import { mkdirSync, readdirSync, statSync, watch, type FSWatcher } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import type { Duplex } from "stream";
import { join } from "path";
import { META_DIR } from "@/lib/core/paths";
import { AuthLimiter, isServerVaultId } from "@/lib/server/auth";
import { createHttpApi, createSyncServer } from "@/lib/server/sync-server";
import { DeviceAuth } from "@/lib/server/device-auth";
import { DeviceStore, grantAllows } from "@/lib/server/devices";

/**
 * Several vaults in one server process (spec item 9, server half).
 *
 * Each vault is a folder under `METHYL_VAULTS_PATH`, served by its own
 * `createSyncServer` — its own SQLite store, change log, room namespace,
 * watcher and Node-side mirror — so nothing one vault does is visible in
 * another. Routes:
 *
 *   GET  /api/vaults                → { vaults: [{ id, ready }] } the caller may use
 *   *    /api/v/<vaultId>/<route>   → that vault's HTTP API
 *   WS   /sync/<vaultId>            → that vault's sync rooms
 *   *    /api/auth/*                → device pairing (see device-auth.ts)
 *
 * Requests authenticate with the admin token or a paired device's cookie;
 * a device may use only the vaults it was paired for. Sync joins carry a
 * short-lived ticket from /api/auth/ws-ticket (or the admin token).
 *
 * The unprefixed `/api/<route>` and any other WebSocket path are aliases for
 * the vault `default`, for clients from before multi-vault (deprecated).
 *
 * With only a single `vaultPath` (METHYL_VAULT_PATH), that one folder is
 * served as `default`.
 */

export { isServerVaultId };
export const DEFAULT_SERVER_VAULT = "default";
/** Server-level state (devices, tickets) under the vaults directory. */
export const SERVER_STATE_DIR = ".methyl-server";

export interface VaultHostOptions {
  /** Directory whose sub-folders are vaults (METHYL_VAULTS_PATH). */
  vaultsPath?: string;
  /** A single vault served as `default` (METHYL_VAULT_PATH), when vaultsPath is unset. */
  vaultPath?: string;
  authToken: string;
  watch?: boolean;
  limiter?: AuthLimiter;
  trustProxy?: boolean;
  maxAssetBytes?: number;
  /** Rescan delay after the vaults directory changes. */
  rescanDelayMs?: number;
  log?: (message: string) => void;
}

type SyncServer = ReturnType<typeof createSyncServer>;

interface HostedVault {
  id: string;
  path: string;
  sync: SyncServer;
  api: ReturnType<typeof createHttpApi>;
  /** Resolves once the vault is serving; rejects if it failed to open. */
  ready: Promise<void>;
  isReady: boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export class VaultHost {
  private readonly opts: VaultHostOptions;
  private readonly limiter: AuthLimiter;
  private readonly vaults = new Map<string, HostedVault>();
  private dirWatcher: FSWatcher | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private rescanning: Promise<void> = Promise.resolve();
  private readonly skippedNames = new Set<string>();
  private warnedLegacyRoutes = false;
  private stopped = false;
  private auth!: DeviceAuth;
  /** Open change streams per device, closed when it is revoked. */
  private readonly deviceStreams = new Map<string, Set<ServerResponse>>();

  constructor(options: VaultHostOptions) {
    if (!options.vaultsPath && !options.vaultPath) {
      throw new Error("VaultHost needs vaultsPath or vaultPath");
    }
    this.opts = options;
    this.limiter = options.limiter ?? new AuthLimiter();
  }

  private log(message: string): void {
    (this.opts.log ?? console.log)(`[methyl] ${message}`);
  }

  /** Directory for server-level state; null in single-vault mode. */
  get stateDir(): string | null {
    return this.opts.vaultsPath ? join(this.opts.vaultsPath, SERVER_STATE_DIR) : null;
  }

  /** Where paired devices are stored. */
  get devicesDbPath(): string {
    return this.opts.vaultsPath
      ? join(this.opts.vaultsPath, SERVER_STATE_DIR, "server.db")
      : join(this.opts.vaultPath!, META_DIR, "server", "server.db");
  }

  /** Paired devices (tests, CLI). */
  get devices(): DeviceStore {
    return this.auth.devices;
  }

  /** Open every vault, then (multi-vault mode) watch for vaults added or removed. */
  async start(): Promise<void> {
    this.auth = new DeviceAuth({
      devices: new DeviceStore(this.devicesDbPath),
      authToken: this.opts.authToken,
      limiter: this.limiter,
      trustProxy: this.opts.trustProxy,
      vaultIds: () => [...this.vaults.keys()].sort(),
      onRevoked: (deviceId) => this.dropDevice(deviceId),
    });
    if (this.opts.vaultsPath) {
      mkdirSync(this.opts.vaultsPath, { recursive: true });
      await this.rescan();
      if (this.opts.watch !== false) {
        // Non-recursive: only folders appearing or disappearing matter here;
        // each vault's own watcher handles what happens inside it.
        this.dirWatcher = watch(this.opts.vaultsPath, () => this.scheduleRescan());
        this.dirWatcher.on("error", (error) => this.log(`vaults directory watch failed: ${String(error)}`));
      }
    } else {
      this.open(DEFAULT_SERVER_VAULT, this.opts.vaultPath!);
    }
    await Promise.all([...this.vaults.values()].map((vault) => vault.ready.catch(() => undefined)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.dirWatcher?.close();
    this.dirWatcher = null;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    await this.rescanning;
    await Promise.all([...this.vaults.keys()].map((id) => this.close(id)));
    for (const streams of this.deviceStreams.values()) for (const res of streams) res.end();
    this.deviceStreams.clear();
    this.auth?.devices.close();
  }

  /** A revoked device's sockets and change streams stop now. */
  private dropDevice(deviceId: string): void {
    const tag = `device:${deviceId}`;
    for (const vault of this.vaults.values()) {
      vault.sync.rooms.disconnectWhere((client) => client.principal === tag);
    }
    for (const res of this.deviceStreams.get(deviceId) ?? []) res.end();
    this.deviceStreams.delete(deviceId);
  }

  /** Authenticate a request to one vault's API; answers it when refused. */
  private authorizeVault(req: IncomingMessage, res: ServerResponse, vaultId: string): boolean {
    const principal = this.auth.authenticate(req, res, vaultId);
    if (!principal) return false;
    if (principal.kind === "device" && /\/events$/.test(new URL(req.url ?? "/", "http://x").pathname)) {
      const id = principal.device.id;
      const streams = this.deviceStreams.get(id) ?? new Set<ServerResponse>();
      this.deviceStreams.set(id, streams);
      streams.add(res);
      res.on("close", () => streams.delete(res));
    }
    return true;
  }

  /** Ids of the vaults being served, in name order. */
  list(): { id: string; ready: boolean }[] {
    return [...this.vaults.values()]
      .map((vault) => ({ id: vault.id, ready: vault.isReady }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The sync server of a vault that is open and ready, or undefined. */
  get(id: string): SyncServer | undefined {
    const vault = this.vaults.get(id);
    return vault?.isReady ? vault.sync : undefined;
  }

  /** Resolves when the vault `id` has finished opening (tests, CLI). */
  whenReady(id: string): Promise<void> {
    return this.vaults.get(id)?.ready ?? Promise.reject(new Error(`no vault ${id}`));
  }

  private scheduleRescan(): void {
    if (this.stopped) return;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.rescan();
    }, this.opts.rescanDelayMs ?? 1000);
  }

  /** Open vault folders that appeared, close ones that went away. */
  rescan(): Promise<void> {
    const run = async () => {
      if (this.stopped || !this.opts.vaultsPath) return;
      const root = this.opts.vaultsPath;
      const present = new Set<string>();
      for (const name of readdirSync(root)) {
        if (name.startsWith(".")) continue; // .methyl-server, dotfiles
        let isDir = false;
        try {
          isDir = statSync(join(root, name)).isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;
        if (!isServerVaultId(name)) {
          if (!this.skippedNames.has(name)) {
            this.skippedNames.add(name);
            this.log(
              `skipping folder "${name}" in the vaults directory: vault names are ` +
                `lower-case letters, digits and hyphens (at most 63)`,
            );
          }
          continue;
        }
        present.add(name);
        if (!this.vaults.has(name)) this.open(name, join(root, name));
      }
      for (const id of [...this.vaults.keys()]) {
        if (!present.has(id)) await this.close(id);
      }
    };
    this.rescanning = this.rescanning.then(run, run).catch((error) => {
      this.log(`rescanning the vaults directory failed: ${String(error)}`);
    });
    return this.rescanning;
  }

  private open(id: string, path: string): void {
    const sync = createSyncServer({
      vaultPath: path,
      authToken: this.opts.authToken,
      watch: this.opts.watch,
      limiter: this.limiter,
      trustProxy: this.opts.trustProxy,
      authorizeJoin: (token, client) => this.auth.authorizeJoin(id, token, client),
      onClientClosed: (client) => this.auth.devices.releaseConnection(client.connectionId),
    });
    const api = createHttpApi({
      store: sync.store,
      authToken: this.opts.authToken,
      assetDir: `${path}/${META_DIR}/server/assets`,
      limiter: this.limiter,
      trustProxy: this.opts.trustProxy,
      maxAssetBytes: this.opts.maxAssetBytes,
      authorize: (req, res) => this.authorizeVault(req, res, id),
      onAssetPut: (assetId, digest) => sync.materializeAsset(assetId, digest),
    });
    const vault: HostedVault = { id, path, sync, api, ready: Promise.resolve(), isReady: false };
    vault.ready = sync.start().then(
      () => {
        vault.isReady = true;
        this.log(`serving vault "${id}" from ${path}`);
      },
      (error) => {
        this.log(`vault "${id}" failed to open: ${error instanceof Error ? error.stack : String(error)}`);
        throw error;
      },
    );
    vault.ready.catch(() => undefined);
    this.vaults.set(id, vault);
  }

  private async close(id: string): Promise<void> {
    const vault = this.vaults.get(id);
    if (!vault) return;
    this.vaults.delete(id);
    await vault.ready.catch(() => undefined);
    await vault.sync.stop().catch((error) => this.log(`closing vault "${id}" failed: ${String(error)}`));
    if (!this.stopped) this.log(`stopped serving vault "${id}" (folder removed)`);
  }

  /** The vault a request path addresses: `/api/v/<id>/…`, else the legacy alias. */
  private route(pathname: string): { id: string | null; legacy: boolean } {
    const match = /^\/api\/v\/([^/]+)(\/.*)?$/.exec(pathname);
    if (match) return { id: decodeURIComponentSafe(match[1]!), legacy: false };
    return { id: DEFAULT_SERVER_VAULT, legacy: true };
  }

  private warnLegacy(what: string): void {
    if (this.warnedLegacyRoutes) return;
    this.warnedLegacyRoutes = true;
    this.log(
      `deprecated: a client used ${what} without a vault id; it is served from the ` +
        `"${DEFAULT_SERVER_VAULT}" vault. Update the app; these aliases will be removed.`,
    );
  }

  /** Handle any `/api/*` request. */
  handleApi(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (this.auth.handle(req, res, url.pathname)) return;
    if (req.method === "GET" && url.pathname === "/api/vaults") {
      const principal = this.auth.authenticate(req, res);
      if (!principal) return;
      const vaults = this.list().filter(
        (vault) => principal.kind === "admin" || grantAllows(principal.device.vaults, vault.id),
      );
      sendJson(res, 200, { vaults });
      return;
    }
    const target = this.route(url.pathname);
    if (target.legacy) this.warnLegacy(url.pathname);
    const vault = target.id === null ? undefined : this.vaults.get(target.id);
    if (!vault) {
      // Don't reveal which vaults exist to an unauthenticated caller.
      if (!this.auth.authenticate(req, res)) return;
      sendJson(res, 404, { error: "unknown vault" });
      return;
    }
    if (!vault.isReady) {
      res.setHeader("retry-after", "2");
      sendJson(res, 503, { error: "vault is still opening" });
      return;
    }
    vault.api(req, res);
  }

  /** Route a WebSocket upgrade to the right vault's room server. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/sync\/([^/]+)\/?$/.exec(url.pathname);
    const id = match ? decodeURIComponentSafe(match[1]!) : DEFAULT_SERVER_VAULT;
    if (!match) this.warnLegacy(`the sync socket at ${url.pathname}`);
    const vault = id ? this.vaults.get(id) : undefined;
    if (!vault || !vault.isReady) {
      socket.end(
        vault
          ? "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\n\r\n"
          : "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    vault.sync.rooms.handleUpgrade(req, socket, head);
  }
}

function decodeURIComponentSafe(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

