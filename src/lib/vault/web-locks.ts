/**
 * Web Locks single-writer protection (§12).
 *
 * One window becomes the vault writer. Additional windows open read-only,
 * can request takeover or focus the existing window.
 */
export async function acquireVaultWriterLock(
  vaultId: string,
  options?: { signal?: AbortSignal },
): Promise<VaultLock | null> {
  if (typeof navigator === "undefined" || !("locks" in navigator)) {
    // Web Locks unsupported (should not happen on modern targets)
    return createLock(null);
  }
  const lock = await navigator.locks.request(
    `adhd-vault:${vaultId}:writer`,
    { mode: "exclusive" as LockMode, ifAvailable: true, signal: options?.signal },
    () => Promise.resolve(true),
  );
  return createLock(lock as unknown as Lock | null);
}

export async function acquireVaultReadLock(
  vaultId: string,
): Promise<VaultLock | null> {
  if (typeof navigator === "undefined" || !("locks" in navigator)) {
    return createLock(null);
  }
  const lock = await navigator.locks.request(
    `adhd-vault:${vaultId}:reader`,
    { mode: "exclusive" as LockMode, ifAvailable: true },
    () => Promise.resolve(true),
  );
  return createLock(lock as unknown as Lock | null);
}

export type VaultLock = {
  active: boolean;
  /** Hold the lock for the duration of `fn`. */
  guard<T>(fn: () => Promise<T>): Promise<T>;
  release(): void;
};

function createLock(lock: Lock | null): VaultLock {
  let released = false;
  return {
    active: lock !== null && !released,
    release: () => {
      released = true;
    },
    guard: async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } finally {
        released = true;
      }
    },
  };
}

export function vaultWriterLockName(vaultId: string): string {
  return `adhd-vault:${vaultId}:writer`;
}

export function vaultReaderLockName(vaultId: string): string {
  return `adhd-vault:${vaultId}:reader`;
}