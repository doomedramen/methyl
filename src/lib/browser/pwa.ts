import { useEffect, useRef, useState } from "react";

export interface InviteEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface PwaState {
  swRegistered: boolean;
  installPrompt: InviteEvent | null;
  persistent: boolean | null;
  quota: { usage: number; quota: number } | null;
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
 * Registers the Serwist-built SW at /sw.js (present only in the static
 * export; dev server doesn't serve it, so registration is skipped there).
 */
export async function registerServiceWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    return Boolean(reg.active || reg.waiting || reg.installing);
  } catch {
    return false;
  }
}

export function usePwa() {
  const [state, setState] = useState<PwaState>({
    swRegistered: false,
    installPrompt: null,
    persistent: null,
    quota: null,
  });
  const notified = useRef(false);

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
    registerServiceWorker().then((ok) => {
      if (alive) setState((s) => ({ ...s, swRegistered: ok }));
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
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return state;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}