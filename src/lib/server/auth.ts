import { createHash, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

/**
 * Compare two secrets without leaking where they differ through timing.
 * Both sides are hashed first so the buffers handed to `timingSafeEqual`
 * always have the same length — comparing lengths would itself leak.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** `Authorization: Bearer <token>` against the expected token, in constant time. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice("Bearer ".length), token);
}

export interface AuthLimiterOptions {
  /** Failures allowed inside `windowMs` before a lockout starts. */
  maxFailures?: number;
  windowMs?: number;
  /** First lockout length; each further lockout doubles it. */
  baseLockoutMs?: number;
  maxLockoutMs?: number;
  /** Entries idle this long are evicted. */
  idleMs?: number;
  now?: () => number;
}

interface LimiterEntry {
  failures: number[];
  lockouts: number;
  lockedUntil: number;
  lastSeen: number;
}

/**
 * In-memory limiter for failed authentication attempts, keyed by client
 * address. After `maxFailures` failures inside `windowMs` the key is locked
 * out; every further lockout doubles, up to `maxLockoutMs`. A success clears
 * the key. Memory stays bounded by evicting idle keys on each call.
 */
export class AuthLimiter {
  private readonly entries = new Map<string, LimiterEntry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly baseLockoutMs: number;
  private readonly maxLockoutMs: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(options: AuthLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 10;
    this.windowMs = options.windowMs ?? 60_000;
    this.baseLockoutMs = options.baseLockoutMs ?? 60_000;
    this.maxLockoutMs = options.maxLockoutMs ?? 15 * 60_000;
    this.idleMs = options.idleMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds until `key` may try again, or 0 if it is not locked out. */
  retryAfterMs(key: string): number {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - this.now());
  }

  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: [], lockouts: 0, lockedUntil: 0, lastSeen: now };
    entry.lastSeen = now;
    entry.failures = entry.failures.filter((t) => now - t < this.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.maxFailures) {
      const length = Math.min(this.maxLockoutMs, this.baseLockoutMs * 2 ** entry.lockouts);
      entry.lockouts += 1;
      entry.lockedUntil = now + length;
      entry.failures = [];
    }
    this.entries.set(key, entry);
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Number of tracked keys (for tests). */
  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const now = this.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= now && now - entry.lastSeen > this.idleMs) this.entries.delete(key);
    }
  }
}

/**
 * The address a request came from. `X-Forwarded-For` is only honoured when
 * the operator says a trusted reverse proxy sits in front
 * (`METHYL_TRUST_PROXY=true`); otherwise any client could pick its own key.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:@._~-]{0,127}$/;

/**
 * Room and asset IDs arrive in URLs. Room IDs look like `doc:<uuid>` or
 * `vault:<id>`; asset IDs are Loro tree IDs (`<counter>@<peer>`), optionally
 * with a `~<12 hex>` conflict suffix. Accept that alphabet only, bounded in
 * length, and never a `..` segment.
 */
export function isValidObjectId(id: string): boolean {
  return ID_RE.test(id) && !id.includes("..");
}

/** A non-negative safe integer from a query parameter, or null. */
export function parseSeq(value: string | null): number | null {
  if (value === null || value === "") return 0;
  if (!/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
