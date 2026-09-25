import type { IncomingMessage, ServerResponse } from "http";
import { AuthLimiter, bearerMatches, clientAddress, isServerVaultId, safeEqual } from "@/lib/server/auth";
import { DEVICE_COOKIE, DeviceStore, grantAllows, readCookie, type Device, type VaultGrant } from "@/lib/server/devices";
import type { RoomClientInfo } from "@/lib/server/room-server";

/**
 * Who a request comes from (spec item 5): the admin token (`METHYL_AUTH_TOKEN`,
 * for pairing and scripts) or a paired device's cookie.
 *
 *   POST   /api/auth/pair          admin: pair this browser → Set-Cookie
 *   POST   /api/auth/ws-ticket     { vault } → { ticket, expiresAt }
 *   GET    /api/auth/me            → { kind, device? }
 *   GET    /api/auth/devices       → { devices }
 *   DELETE /api/auth/devices/<id>  admin, or the device itself
 */

export type Principal = { kind: "admin" } | { kind: "device"; device: Device };

export function principalTag(principal: Principal): string {
  return principal.kind === "admin" ? "admin" : `device:${principal.device.id}`;
}

const MAX_BODY_BYTES = 4096;
const COOKIE_MAX_AGE_S = 10 * 365 * 24 * 3600;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * Loopback hosts may use plain HTTP (local development), so their cookie
 * can't be `Secure`. Anywhere else the app is served over HTTPS (OPFS and
 * the service worker need a secure context), usually via a TLS proxy.
 */
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

function deviceCookie(req: IncomingMessage, value: string, maxAge = COOKIE_MAX_AGE_S): string {
  const secure = isLoopbackHost(req) ? "" : "; Secure";
  return `${DEVICE_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

export interface DeviceAuthOptions {
  devices: DeviceStore;
  authToken: string;
  limiter: AuthLimiter;
  trustProxy?: boolean;
  /** Ids of the vaults being served. */
  vaultIds: () => string[];
  /** A device was revoked: drop its sockets and streams. */
  onRevoked: (deviceId: string) => void;
}

export class DeviceAuth {
  constructor(private readonly opts: DeviceAuthOptions) {}

  get devices(): DeviceStore {
    return this.opts.devices;
  }

  /**
   * The principal behind a request; "bad" when it presented credentials
   * that don't check out; null when it presented none.
   */
  identify(req: IncomingMessage): Principal | "bad" | null {
    const header = req.headers["authorization"];
    if (typeof header === "string" && header.length > 0) {
      return bearerMatches(header, this.opts.authToken) ? { kind: "admin" } : "bad";
    }
    const cookie = readCookie(req.headers.cookie, DEVICE_COOKIE);
    if (cookie !== null) {
      const device = this.opts.devices.verify(cookie);
      return device ? { kind: "device", device } : "bad";
    }
    return null;
  }

  /**
   * Authenticate a request, answering 429/401/403 itself when refused.
   * With `vault`, a device must also be allowed that vault.
   */
  authenticate(req: IncomingMessage, res: ServerResponse, vault?: string): Principal | null {
    const client = clientAddress(req, this.opts.trustProxy ?? false);
    const retryAfter = this.opts.limiter.retryAfterMs(client);
    if (retryAfter > 0) {
      res.setHeader("retry-after", String(Math.ceil(retryAfter / 1000)));
      sendJson(res, 429, { error: "too many failed attempts" });
      return null;
    }
    const principal = this.identify(req);
    if (principal === "bad") this.opts.limiter.recordFailure(client);
    if (principal === null || principal === "bad") {
      sendJson(res, 401, { error: "unauthorized" });
      return null;
    }
    this.opts.limiter.recordSuccess(client);
    if (vault !== undefined && principal.kind === "device" && !grantAllows(principal.device.vaults, vault)) {
      sendJson(res, 403, { error: "this device is not paired for that vault" });
      return null;
    }
    return principal;
  }

  /** May `principal` use `vault`? */
  allows(principal: Principal, vault: string): boolean {
    return principal.kind === "admin" || grantAllows(principal.device.vaults, vault);
  }

  /**
   * A room join on `vault`'s socket: the admin token, or a ticket issued for
   * this vault (bound to the connection on first use). Records the principal
   * on the connection so a revoke can find it.
   */
  authorizeJoin(vault: string, token: string, client: RoomClientInfo): boolean {
    if (safeEqual(token, this.opts.authToken)) {
      client.principal = "admin";
      return true;
    }
    const principal = this.opts.devices.redeemTicket(token, vault, client.connectionId);
    if (!principal) return false;
    client.principal = principal;
    return true;
  }

  /** Handle `/api/auth/*`. Returns false when the path isn't one of these routes. */
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (!pathname.startsWith("/api/auth/")) return false;
    const route = pathname.slice("/api/auth/".length);
    const run = async () => {
      if (req.method === "POST" && route === "pair") return this.pair(req, res);
      if (req.method === "POST" && route === "ws-ticket") return this.ticket(req, res);
      if (req.method === "GET" && route === "me") return this.me(req, res);
      if (req.method === "GET" && route === "devices") return this.list(req, res);
      if (req.method === "DELETE" && route.startsWith("devices/")) {
        return this.revoke(req, res, decodeURIComponent(route.slice("devices/".length)));
      }
      sendJson(res, 404, { error: "not found" });
    };
    run().catch((error: unknown) => {
      if (res.headersSent) return;
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only the admin token pairs; a device can't mint devices.
    const client = clientAddress(req, this.opts.trustProxy ?? false);
    const retryAfter = this.opts.limiter.retryAfterMs(client);
    if (retryAfter > 0) {
      res.setHeader("retry-after", String(Math.ceil(retryAfter / 1000)));
      return sendJson(res, 429, { error: "too many failed attempts" });
    }
    if (!bearerMatches(req.headers["authorization"], this.opts.authToken)) {
      this.opts.limiter.recordFailure(client);
      return sendJson(res, 401, { error: "pairing needs the server's admin token" });
    }
    this.opts.limiter.recordSuccess(client);

    const body = await readJson(req);
    const name = typeof body.deviceName === "string" && body.deviceName.trim()
      ? body.deviceName.trim().slice(0, 100)
      : "Unnamed device";
    let vaults: VaultGrant;
    if (body.vaults === "*" || body.vaults === undefined) vaults = "*";
    else if (Array.isArray(body.vaults) && body.vaults.every((v) => typeof v === "string" && isServerVaultId(v))) {
      vaults = body.vaults as string[];
    } else return sendJson(res, 400, { error: "vaults must be \"*\" or a list of vault ids" });

    // Pairing again from a browser that's already paired adds the vaults to
    // the same device instead of leaving the old one behind.
    const existing = readCookie(req.headers.cookie, DEVICE_COOKIE);
    const current = existing ? this.opts.devices.verify(existing) : null;
    if (current) {
      const device = this.opts.devices.extend(current.id, vaults, name);
      return sendJson(res, 200, { device });
    }
    const { device, cookie } = this.opts.devices.pair(name, vaults);
    res.setHeader("set-cookie", deviceCookie(req, cookie));
    sendJson(res, 201, { device });
  }

  private async ticket(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const principal = this.authenticate(req, res);
    if (!principal) return;
    const body = await readJson(req);
    const vault = body.vault;
    if (typeof vault !== "string" || !isServerVaultId(vault)) {
      return sendJson(res, 400, { error: "vault must be a vault id" });
    }
    if (!this.allows(principal, vault)) {
      return sendJson(res, 403, { error: "this device is not paired for that vault" });
    }
    sendJson(res, 200, this.opts.devices.issueTicket(principalTag(principal), vault));
  }

  private me(req: IncomingMessage, res: ServerResponse): void {
    const principal = this.authenticate(req, res);
    if (!principal) return;
    if (principal.kind === "admin") return sendJson(res, 200, { kind: "admin", vaults: this.opts.vaultIds() });
    const vaults = this.opts.vaultIds().filter((id) => grantAllows(principal.device.vaults, id));
    sendJson(res, 200, { kind: "device", device: principal.device, vaults });
  }

  private list(req: IncomingMessage, res: ServerResponse): void {
    const principal = this.authenticate(req, res);
    if (!principal) return;
    const self = principal.kind === "device" ? principal.device.id : null;
    sendJson(res, 200, {
      devices: this.opts.devices.list().map((device) => ({ ...device, current: device.id === self })),
    });
  }

  private revoke(req: IncomingMessage, res: ServerResponse, id: string): void {
    const principal = this.authenticate(req, res);
    if (!principal) return;
    const self = principal.kind === "device" && principal.device.id === id;
    if (principal.kind !== "admin" && !self) {
      return sendJson(res, 403, { error: "only the admin token can remove other devices" });
    }
    if (!this.opts.devices.revoke(id)) return sendJson(res, 404, { error: "unknown device" });
    this.opts.onRevoked(id);
    if (self) res.setHeader("set-cookie", deviceCookie(req, "", 0));
    sendJson(res, 200, { revoked: id });
  }
}
