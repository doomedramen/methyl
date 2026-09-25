import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

/**
 * Paired devices and WebSocket tickets (spec item 5, SPEC §31).
 *
 * A device is paired once with the admin token and gets a random 256-bit
 * secret, kept by the browser in an HttpOnly cookie. The server stores only
 * the secret's SHA-256. Each device may use the vaults it was paired for
 * (or every vault, `"*"`).
 *
 * The sync socket's join payload is a ticket: random, valid for 60 s, scoped
 * to one vault, and redeemed by one connection — the first join binds it to
 * that socket, and later joins on the same socket reuse it (one sync round
 * joins many rooms). Tickets live in memory only.
 */

export const DEVICE_COOKIE = "methyl_device";
export const TICKET_TTL_MS = 60_000;

/** Every vault on the server. */
export type VaultGrant = "*" | string[];

export interface Device {
  id: string;
  name: string;
  vaults: VaultGrant;
  createdAt: number;
  lastSeenAt: number | null;
}

interface DeviceRow {
  id: string;
  name: string;
  secretHash: string;
  vaults: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

interface Ticket {
  /** `device:<id>` or `admin`. */
  principal: string;
  vault: string;
  expiresAt: number;
  /** The connection that redeemed it. */
  boundTo: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secretHash TEXT NOT NULL,
  vaults TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  lastSeenAt INTEGER,
  revokedAt INTEGER
);
`;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toDevice(row: DeviceRow): Device {
  let vaults: VaultGrant = [];
  try {
    const parsed = JSON.parse(row.vaults) as unknown;
    if (parsed === "*") vaults = "*";
    else if (Array.isArray(parsed)) vaults = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // an unreadable grant allows nothing
  }
  return { id: row.id, name: row.name, vaults, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt };
}

export function grantAllows(grant: VaultGrant, vault: string): boolean {
  return grant === "*" || grant.includes(vault);
}

function mergeGrants(a: VaultGrant, b: VaultGrant): VaultGrant {
  if (a === "*" || b === "*") return "*";
  return [...new Set([...a, ...b])].sort();
}

export class DeviceStore {
  private readonly db: Database.Database;
  private readonly tickets = new Map<string, Ticket>();
  private readonly now: () => number;

  constructor(dbPath: string, options: { now?: () => number } = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(SCHEMA);
    this.now = options.now ?? Date.now;
  }

  close(): void {
    this.tickets.clear();
    this.db.close();
  }

  /** Pair a new device. Returns it and the cookie value (`<id>.<secret>`), shown to no one else. */
  pair(name: string, vaults: VaultGrant): { device: Device; cookie: string } {
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    this.db
      .prepare("INSERT INTO devices (id, name, secretHash, vaults, createdAt) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, sha256Hex(secret), JSON.stringify(vaults), createdAt);
    return {
      device: { id, name, vaults, createdAt, lastSeenAt: null },
      cookie: `${id}.${secret}`,
    };
  }

  /** Add vaults to an already-paired device (pairing again from the same browser). */
  extend(id: string, vaults: VaultGrant, name?: string): Device | null {
    const device = this.get(id);
    if (!device) return null;
    const merged = mergeGrants(device.vaults, vaults);
    this.db
      .prepare("UPDATE devices SET vaults = ?, name = COALESCE(?, name) WHERE id = ?")
      .run(JSON.stringify(merged), name ?? null, id);
    return { ...device, vaults: merged, name: name ?? device.name };
  }

  get(id: string): Device | null {
    const row = this.db
      .prepare("SELECT * FROM devices WHERE id = ? AND revokedAt IS NULL")
      .get(id) as DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }

  list(): Device[] {
    const rows = this.db
      .prepare("SELECT * FROM devices WHERE revokedAt IS NULL ORDER BY createdAt")
      .all() as DeviceRow[];
    return rows.map(toDevice);
  }

  /** The device a cookie value belongs to, or null (unknown, revoked, or wrong secret). */
  verify(cookie: string): Device | null {
    const dot = cookie.indexOf(".");
    if (dot <= 0) return null;
    const id = cookie.slice(0, dot);
    const secret = cookie.slice(dot + 1);
    const row = this.db
      .prepare("SELECT * FROM devices WHERE id = ? AND revokedAt IS NULL")
      .get(id) as DeviceRow | undefined;
    // Hash either way so an unknown id costs the same as a wrong secret.
    const presented = Buffer.from(sha256Hex(secret), "hex");
    const expected = Buffer.from(row?.secretHash ?? sha256Hex(randomUUID()), "hex");
    if (!row || !timingSafeEqual(presented, expected)) return null;
    const now = this.now();
    // Coarse: at most one write a minute per device.
    if (!row.lastSeenAt || now - row.lastSeenAt > 60_000) {
      this.db.prepare("UPDATE devices SET lastSeenAt = ? WHERE id = ?").run(now, id);
    }
    return toDevice(row);
  }

  revoke(id: string): boolean {
    const result = this.db
      .prepare("UPDATE devices SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL")
      .run(this.now(), id);
    for (const [ticket, entry] of this.tickets) {
      if (entry.principal === `device:${id}`) this.tickets.delete(ticket);
    }
    return result.changes > 0;
  }

  /** A fresh ticket for `principal` to join rooms of `vault`. */
  issueTicket(principal: string, vault: string): { ticket: string; expiresAt: number } {
    this.sweepTickets();
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + TICKET_TTL_MS;
    this.tickets.set(ticket, { principal, vault, expiresAt, boundTo: null });
    return { ticket, expiresAt };
  }

  /**
   * Redeem a ticket for a join on `connectionId` to `vault`. The first join
   * binds it (within its 60 s); later joins on the same connection pass;
   * any other connection is refused. Returns the principal, or null.
   */
  redeemTicket(ticket: string, vault: string, connectionId: string): string | null {
    const entry = this.tickets.get(ticket);
    if (!entry || entry.vault !== vault) return null;
    if (entry.boundTo === null) {
      if (this.now() > entry.expiresAt) {
        this.tickets.delete(ticket);
        return null;
      }
      entry.boundTo = connectionId;
      return entry.principal;
    }
    return entry.boundTo === connectionId ? entry.principal : null;
  }

  /** Forget the tickets a closed connection redeemed. */
  releaseConnection(connectionId: string): void {
    for (const [ticket, entry] of this.tickets) {
      if (entry.boundTo === connectionId) this.tickets.delete(ticket);
    }
  }

  private sweepTickets(): void {
    const now = this.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.boundTo === null && now > entry.expiresAt) this.tickets.delete(ticket);
    }
  }
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}
