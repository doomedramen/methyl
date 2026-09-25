/**
 * Web Locks single-writer protection (§12).
 *
 * One tab becomes the vault writer, holding an exclusive Web Lock for its
 * entire lifetime. Other tabs open read-only. A read-only tab can:
 *   - wait in the background to be promoted once the writer tab releases
 *     (closes / navigates away) — see waitForVaultWriterPromotion, or
 *   - explicitly take over now via `steal` — see acquireVaultWriterLock's
 *     `steal` option.
 *
 * `navigator.locks.request(name, opts, callback)` only holds the lock for
 * as long as the promise `callback` returns stays pending — it releases
 * the instant that promise settles. A callback like `() =>
 * Promise.resolve(true)` (the previous version of this file) therefore
 * grants and releases the lock in the same microtask: nothing was ever
 * really held, so `ifAvailable` always reported success and every tab
 * believed itself to be the writer. requestHeldLock() below fixes this by
 * giving the callback a promise this module controls (`releaseHeld`),
 * resolved only when the caller explicitly calls `.release()`.
 */

export interface VaultLock {
  /** Whether this call actually acquired the lock. */
  active: boolean;
  /** Release the lock (no-op if not active or already released). */
  release(): void;
  /** Hold the lock for the duration of `fn`, then release it. */
  guard<T>(fn: () => Promise<T>): Promise<T>;
}

function lockName(vaultId: string, kind: "writer" | "op", scope?: string): string {
  return scope ? `methyl:${vaultId}:${kind}:${scope}` : `methyl:${vaultId}:${kind}`;
}

/**
 * The single vault's writer lock before multi-vault. A tab of an older build
 * still holds this while it writes the old `adhd-vault` OPFS root; the
 * layout migration takes it first so that tab can't write mid-copy.
 */
export const LEGACY_WRITER_LOCK_NAME = "adhd-vault:local:writer";

export function vaultWriterLockName(vaultId: string): string {
  return lockName(vaultId, "writer");
}

export function vaultOpLockName(vaultId: string, scope: string): string {
  return lockName(vaultId, "op", scope);
}

/**
 * `steal: true` immediately preempts the current holder at the Web Locks
 * level, but the browser doesn't tell that holder's JS it happened — its
 * `requestHeldLock` callback just silently stops actually holding
 * anything, with no callback/rejection of its own. A `BroadcastChannel`
 * (same origin, so it reaches every other tab) closes that gap: the
 * stealer announces the takeover, and the victim (vault.ts) listens and
 * reacts (demotes itself / reloads) instead of carrying on believing it's
 * still the writer.
 */
function stealChannelName(vaultId: string): string {
  return `methyl:${vaultId}:writer-steal`;
}

function announceSteal(vaultId: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  const ch = new BroadcastChannel(stealChannelName(vaultId));
  ch.postMessage({ at: Date.now() });
  ch.close();
}

/** Notified when another tab steals the writer lock out from under this one. */
export function onVaultWriterStolen(vaultId: string, listener: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const ch = new BroadcastChannel(stealChannelName(vaultId));
  ch.onmessage = () => listener();
  return () => ch.close();
}

const BACKGROUND_SYNC_YIELD_CHANNEL = "methyl:background-sync-yield";

/** Ask a background sync host in another tab to release this vault's writer lock. */
export function requestBackgroundSyncYield(vaultId: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(BACKGROUND_SYNC_YIELD_CHANNEL);
  channel.postMessage({ type: "foreground-open", vaultId });
  channel.close();
}

/** Listen for a foreground tab that needs a background sync lock released. */
export function onBackgroundSyncYieldRequest(listener: (vaultId: string) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(BACKGROUND_SYNC_YIELD_CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as { type?: unknown; vaultId?: unknown } | null;
    if (message?.type === "foreground-open" && typeof message.vaultId === "string") listener(message.vaultId);
  };
  return () => channel.close();
}

/**
 * Acquire the long-lived, exclusive per-vault "writer" lock. Held until
 * `.release()` is called (e.g. on tab close via `pagehide`, or on
 * demotion) — the browser also force-releases it if the tab's context is
 * destroyed without a clean release (crash/kill), so a stuck lock can't
 * outlive the tab that held it.
 *
 * `ifAvailable` (default true): resolve immediately with `active:false`
 * if another tab already holds it, instead of queueing. Pass
 * `steal: true` for an explicit takeover ("Use here") — this immediately
 * preempts whatever tab currently holds it.
 */
export async function acquireVaultWriterLock(
  vaultId: string,
  options?: { signal?: AbortSignal; steal?: boolean; ifAvailable?: boolean },
): Promise<VaultLock> {
  const lock = await requestHeldLock(vaultWriterLockName(vaultId), {
    ifAvailable: options?.steal ? false : (options?.ifAvailable ?? true),
    steal: options?.steal,
    signal: options?.signal,
  });
  if (options?.steal && lock.active) announceSteal(vaultId);
  return lock;
}

/**
 * Queue (blocking — not `ifAvailable`) for the writer lock. Used by a
 * read-only tab to be promoted automatically once the current writer
 * releases it (closes/navigates away) — no polling needed, the browser
 * grants this request the moment the lock becomes free.
 *
 * Pass `signal` to abandon the wait (e.g. if this tab itself is closing).
 */
export function waitForVaultWriterPromotion(
  vaultId: string,
  signal?: AbortSignal,
): Promise<VaultLock> {
  return requestHeldLock(vaultWriterLockName(vaultId), { ifAvailable: false, signal });
}

/**
 * Short-lived per-operation mutex, scoped to what it's protecting (e.g. a
 * documentId, or "tree") — both *distinct from the writer lock's name*
 * and *distinct per scope*. Web Locks are exclusive per name across the
 * whole origin, including within the same tab/page:
 *   - Reusing the writer lock's own name here (as this codebase's editor
 *     session used to) would deadlock forever once that lock genuinely
 *     holds open for the tab's lifetime — the whole reason this lock
 *     exists as a separate name.
 *   - Sharing *one* op-lock name across every scope (e.g. one lock for
 *     the whole vault) would needlessly serialize unrelated concurrent
 *     writes — saving note A and note B at the same time would block on
 *     each other despite touching different files. Scoping by `scope`
 *     (typically a documentId) keeps only genuinely-conflicting writes
 *     (the same document, or the tree) serialized.
 * This lock genuinely blocks (not `ifAvailable`) so concurrent operations
 * on the same scope serialize instead of silently skipping.
 */
export async function acquireVaultOpLock(vaultId: string, scope: string): Promise<VaultLock> {
  return requestHeldLock(vaultOpLockName(vaultId, scope), { ifAvailable: false });
}

function requestHeldLock(
  name: string,
  opts: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
): Promise<VaultLock> {
  if (typeof navigator === "undefined" || !("locks" in navigator)) {
    // No Web Locks support (old browser, or a non-browser test/SSR
    // context): behave as always-available with a real held/release
    // cycle so callers' semantics (active/guard/release) still hold.
    return Promise.resolve(makeVaultLock(true, () => {}));
  }

  return new Promise<VaultLock>((resolveOuter) => {
    let releaseHeld: (() => void) | null = null;
    let settled = false;

    const settle = (active: boolean) => {
      if (settled) return;
      settled = true;
      resolveOuter(makeVaultLock(active, () => releaseHeld?.()));
    };

    const requestOptions: Parameters<LockManager["request"]>[1] = {
      mode: "exclusive",
      ifAvailable: opts.ifAvailable ?? false,
      ...(opts.steal ? { steal: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    navigator.locks
      .request(name, requestOptions, (lock) => {
        if (lock === null) {
          // ifAvailable + unavailable: nothing was granted, nothing to hold.
          settle(false);
          return Promise.resolve();
        }
        settle(true);
        // Stay pending until release() calls releaseHeld() — this is what
        // keeps the underlying Web Lock actually held.
        return new Promise<void>((resolveCallback) => {
          releaseHeld = resolveCallback;
        });
      })
      .catch(() => settle(false));
  });
}

function makeVaultLock(active: boolean, releaseFn: () => void): VaultLock {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseFn();
  };
  return {
    active,
    release,
    guard: async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
