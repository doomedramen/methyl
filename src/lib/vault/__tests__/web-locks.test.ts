import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireVaultWriterLock,
  acquireVaultOpLock,
  waitForVaultWriterPromotion,
} from "@/lib/vault/web-locks";

/**
 * A small in-memory LockManager honoring the subset of the Web Locks API
 * these tests need: exclusive mode, `ifAvailable`, `steal`, and a FIFO
 * queue for blocking requests — held only for as long as the callback's
 * returned promise stays pending, exactly like the real API (see
 * web-locks.ts's class doc for why that distinction is the whole bug).
 */
class FakeLockManager {
  private held = new Map<string, symbol>();
  private queue = new Map<string, Array<() => void>>();

  async request(
    name: string,
    options: { mode?: string; ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => Promise<unknown>,
  ): Promise<unknown> {
    if (options.steal) {
      this.held.delete(name); // preempt whoever held it; they get no notification (matches the real API)
    } else if (this.held.has(name)) {
      if (options.ifAvailable) {
        return callback(null);
      }
      // Queue and wait to be granted.
      await new Promise<void>((resolve) => {
        const q = this.queue.get(name) ?? [];
        q.push(resolve);
        this.queue.set(name, q);
      });
    }
    const token = Symbol(name);
    this.held.set(name, token);
    try {
      return await callback({ name });
    } finally {
      if (this.held.get(name) === token) this.held.delete(name);
      const next = this.queue.get(name)?.shift();
      next?.();
    }
  }
}

// Node's built-in global `navigator` (21+) only has a getter, so it can't be
// reassigned or have `.locks` set directly — replace it with a fresh
// configurable property for the duration of each test instead.
let originalDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { locks: new FakeLockManager() },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalDescriptor);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
});

describe("acquireVaultWriterLock", () => {
  it("acquires when free", async () => {
    const lock = await acquireVaultWriterLock("v1");
    expect(lock.active).toBe(true);
    lock.release();
  });

  it("a second tab's ifAvailable request fails while the first still holds it", async () => {
    const first = await acquireVaultWriterLock("v1");
    expect(first.active).toBe(true);

    const second = await acquireVaultWriterLock("v1");
    expect(second.active).toBe(false);

    first.release();
  });

  it("genuinely holds the lock until release() — the regression this whole fix is for", async () => {
    // Before the fix, the callback resolved immediately
    // (`() => Promise.resolve(true)`), so the lock was released in the
    // same microtask it was granted and a second `ifAvailable` request
    // would incorrectly succeed too.
    const first = await acquireVaultWriterLock("v1");
    expect(first.active).toBe(true);

    // Give any stray microtasks a chance to run before checking.
    await Promise.resolve();
    await Promise.resolve();

    const second = await acquireVaultWriterLock("v1");
    expect(second.active).toBe(false); // still held by `first`

    first.release();
    // release() resolves the held promise asynchronously (a microtask),
    // same as the real Web Locks API — give it a tick to actually free the
    // lock before requesting again.
    await Promise.resolve();
    await Promise.resolve();
    const third = await acquireVaultWriterLock("v1");
    expect(third.active).toBe(true); // free now
    third.release();
  });

  it("release() lets a queued waiter (promotion) through", async () => {
    const writer = await acquireVaultWriterLock("v1");
    expect(writer.active).toBe(true);

    const promotion = waitForVaultWriterPromotion("v1");
    // Not yet resolved — writer still holds it.
    let resolved = false;
    void promotion.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    writer.release();
    const promoted = await promotion;
    expect(promoted.active).toBe(true);
    promoted.release();
  });

  it("steal preempts the current holder immediately", async () => {
    const writer = await acquireVaultWriterLock("v1");
    expect(writer.active).toBe(true);

    const stolen = await acquireVaultWriterLock("v1", { steal: true });
    expect(stolen.active).toBe(true);
    stolen.release();
  });
});

describe("acquireVaultOpLock — separate lock name from the writer lock", () => {
  it("does not deadlock against a tab's own long-lived writer lock", async () => {
    const writer = await acquireVaultWriterLock("v1");
    expect(writer.active).toBe(true);

    // Regression: this used to call acquireVaultWriterLock(vaultId) again
    // (see src/lib/editor/session.ts before the fix), which — once the
    // writer lock genuinely holds — would block forever against itself.
    const op = await acquireVaultOpLock("v1", "doc-x");
    expect(op.active).toBe(true);
    op.release();

    writer.release();
  });

  it("serializes concurrent operations instead of silently skipping (real mutex, not ifAvailable)", async () => {
    const order: string[] = [];

    const run = async (label: string) => {
      const lock = await acquireVaultOpLock("v1", "doc-x");
      await lock.guard(async () => {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${label}:end`);
      });
    };

    await Promise.all([run("a"), run("b")]);

    // Never interleaved — "a" fully finishes before "b" starts, or vice versa.
    const aStart = order.indexOf("a:start");
    const aEnd = order.indexOf("a:end");
    const bStart = order.indexOf("b:start");
    const bEnd = order.indexOf("b:end");
    const aFirst = aEnd < bStart;
    const bFirst = bEnd < aStart;
    expect(aFirst || bFirst).toBe(true);
  });

  it("different scopes (e.g. different documentIds) do not serialize against each other", async () => {
    const order: string[] = [];

    const run = async (label: string, scope: string) => {
      const lock = await acquireVaultOpLock("v1", scope);
      await lock.guard(async () => {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${label}:end`);
      });
    };

    await Promise.all([run("docA", "doc-a"), run("docB", "doc-b")]);

    // Interleaved: both started before either finished — saving two
    // different notes at once must not block on each other.
    expect(order[0]).toBe("docA:start");
    expect(order[1]).toBe("docB:start");
  });
});
