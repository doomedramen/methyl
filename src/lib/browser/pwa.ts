import { useCallback, useEffect, useRef, useState } from "react";

export interface InviteEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface PwaState {
  /** Offline app shell: registering, active, or blocked/unsupported. */
  offline: "pending" | "ready" | "unavailable" | "disabled";
  installPrompt: InviteEvent | null;
  persistent: boolean | null;
  quota: { usage: number; quota: number } | null;
  /** A new SW has installed and is waiting — applyUpdate() activates it. */
  updateReady: boolean;
}

interface NavWithStandalone {
  standalone?: boolean;
}

export function supportsPwaInstall(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator;
}

export async function tryPersistStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted) {
      const already = await navigator.storage.persisted();
      if (already) return true;
    }
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function readQuota(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const est = await navigator.storage.estimate();
    if (typeof est.usage !== "number" || typeof est.quota !== "number") return null;
    return { usage: est.usage, quota: est.quota };
  } catch {
    return null;
  }
}

export function isStandalone(): boolean {
  return (
    (navigator as Navigator & typeof navigator & NavWithStandalone).standalone ===
      true ||
    (matchMedia("(display-mode: standalone)").matches as boolean)
  );
}

/**
 * Registers the Serwist-built SW at /sw.js in production builds. In
 * development it unregisters any existing worker and clears its caches so
 * code changes show on reload instead of stale cached chunks. Registration
 * fails in browsers or webviews that block service workers.
 *
 * Returns the registration (so callers can watch it for updates) alongside
 * the coarse offline-readiness state.
 */
export async function registerServiceWorker(): Promise<{
  offline: PwaState["offline"];
  registration: ServiceWorkerRegistration | null;
}> {
  if (!("serviceWorker" in navigator)) return { offline: "unavailable", registration: null };
  if (process.env.NODE_ENV !== "production") {
    await unregisterDevServiceWorker();
    return { offline: "disabled", registration: null };
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const offline = reg.active || reg.waiting || reg.installing ? "ready" : "unavailable";
    return { offline, registration: reg };
  } catch (err) {
    console.warn("[pwa] service worker registration failed", err);
    return { offline: "unavailable", registration: null };
  }
}

async function unregisterDevServiceWorker(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    // Only Serwist's own caches; vault data lives in OPFS, not Cache Storage.
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("serwist-") || k === "adhd-wasm").map((k) => caches.delete(k)),
    );
  } catch (err) {
    console.warn("[pwa] dev service worker cleanup failed", err);
  }
}

export function usePwa() {
  const [state, setState] = useState<PwaState>({
    offline: "pending",
    installPrompt: null,
    persistent: null,
    quota: null,
    updateReady: false,
  });
  const notified = useRef(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setState((s) => ({ ...s, installPrompt: e as InviteEvent }));
    };
    const onInstalled = () => {
      setState((s) => ({ ...s, installPrompt: null }));
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    let alive = true;

    // A worker already sitting in `waiting` (installed while no tab was
    // open, or from a previous visit) means an update is ready right away.
    const watchForWaiting = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting && navigator.serviceWorker.controller) {
        setState((s) => ({ ...s, updateReady: true }));
      }
      // `updatefound` fires when reg.installing appears (a new SW started
      // installing, whether from our own reg.update() call or a fetch of
      // /sw.js the browser did on its own). Once it flips to "installed"
      // *and* there's already a controller, the old worker is still
      // running the page — that's exactly the "update ready" moment.
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            setState((s) => ({ ...s, updateReady: true }));
          }
        });
      });
    };

    registerServiceWorker().then(({ offline, registration }) => {
      if (!alive) return;
      setState((s) => ({ ...s, offline }));
      if (registration) {
        registrationRef.current = registration;
        watchForWaiting(registration);
      }
    });
    tryPersistStorage().then((p) => {
      if (alive) setState((s) => ({ ...s, persistent: p }));
    });
    const refreshQuota = () =>
      readQuota().then((q) => {
        if (alive) setState((s) => ({ ...s, quota: q }));
      });
    refreshQuota();
    const t = setInterval(refreshQuota, 30_000);

    // Cheap freshness check: the browser re-fetches /sw.js (byte-compared
    // against the installed worker) and starts installing a new one if it
    // differs. Doesn't force anything on the user — just makes "reload to
    // update" show up sooner than waiting for the browser's own ~24h check.
    const checkForUpdate = () => registrationRef.current?.update().catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === "visible") checkForUpdate();
    };
    document.addEventListener("visibilitychange", onVisible);
    const hourly = setInterval(checkForUpdate, 60 * 60 * 1000);

    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(hourly);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Activates the waiting worker and reloads once it takes control. The
  // reload is tied to `controllerchange` (fired exactly once, when the new
  // worker claims clients) rather than done eagerly, so it can't race the
  // activation and reload onto a half-updated worker.
  const applyUpdate = useCallback(() => {
    const reg = registrationRef.current;
    if (!reg?.waiting) return;
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => window.location.reload(),
      { once: true },
    );
    reg.waiting.postMessage("SKIP_WAITING");
  }, []);

  return { ...state, applyUpdate };
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}