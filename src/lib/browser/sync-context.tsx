"use client";

/**
 * Wires SyncHost into the app lifecycle (SPEC §18-§34):
 *   - Starts only once the vault engine holds the writer lock (§12) — a
 *     read-only second tab must not also open a sync connection.
 *   - Reconnects with backoff on network loss, `online`, and
 *     `visibilitychange` (SyncScheduler already backs off on failure; this
 *     wires the browser signals that should force an immediate retry).
 *   - Stops on disconnect (config cleared) or when the config changes.
 *   - Exposes status + config + connect/test/disconnect actions to any
 *     component (footer status popover, ⌘K, the Sync dialog) via context.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { VaultEngine } from "@/lib/vault/engine";
import type { SyncHost as SyncHostType, SyncStatus } from "@/lib/browser/sync-host";
import type { SyncReport } from "@/lib/sync/coordinator";
import {
  clearSyncConfig,
  deriveSyncUrls,
  loadSyncConfig,
  saveSyncConfig,
  testSyncConnection,
  type SyncConfig,
} from "@/lib/browser/sync-config";

const VAULT_ID = "local";

export interface SyncContextValue {
  config: SyncConfig | null;
  status: SyncStatus;
  /** Undefined until the writer-lock tab has decided whether it can sync at all. */
  canSync: boolean;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  save: (config: SyncConfig) => void;
  disconnect: () => void;
  testConnection: (config: SyncConfig) => ReturnType<typeof testSyncConnection>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync must be used within SyncProvider");
  return ctx;
}

export function SyncProvider({
  engine,
  onRemoteChange,
  children,
}: {
  engine: VaultEngine | null;
  /** Fired after a round that touched the tree or a doc room — refresh the sidebar. */
  onRemoteChange?: (report: SyncReport) => void;
  children: ReactNode;
}) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [status, setStatus] = useState<SyncStatus>({ kind: "idle" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const hostRef = useRef<SyncHostType | null>(null);
  const onRemoteChangeRef = useRef(onRemoteChange);
  onRemoteChangeRef.current = onRemoteChange;

  useEffect(() => {
    setConfig(loadSyncConfig());
  }, []);

  const canSync = !!engine && !!engine.releaseWriterLock;

  // Start/stop the host whenever the engine becomes syncable or config changes.
  useEffect(() => {
    let cancelled = false;
    if (!canSync || !engine || !config) {
      setStatus({ kind: "idle" });
      return;
    }

    setStatus({ kind: "connecting" });

    Promise.all([import("@/lib/vault/opfs"), import("@/lib/browser/sync-host")])
      .then(async ([{ OpfsVaultFS }, { SyncHost }]) => {
        if (cancelled) return;
        const fs = new OpfsVaultFS();
        const { wsUrl, httpUrl } = deriveSyncUrls(config.serverUrl);
        const host = await SyncHost.create({
          fs,
          engine,
          wsUrl,
          httpUrl,
          authToken: config.authToken,
          vaultId: VAULT_ID,
        });
        if (cancelled) {
          host.stop();
          return;
        }
        hostRef.current = host;
        host.onStatusChange(setStatus);
        host.onRemoteChange((report) => onRemoteChangeRef.current?.(report));
        host.start();
      })
      .catch((err) => {
        console.error("[sync] failed to start SyncHost", err);
        if (!cancelled) setStatus({ kind: "error", message: String(err) });
      });

    return () => {
      cancelled = true;
      hostRef.current?.stop();
      hostRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSync, engine, config?.serverUrl, config?.authToken]);

  // Reconnect promptly on network/visibility signals rather than waiting for
  // the next backoff-scheduled attempt.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const kick = () => hostRef.current?.kick();
    const onVisibility = () => {
      if (document.visibilityState === "visible") kick();
    };
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const save = useCallback((next: SyncConfig) => {
    saveSyncConfig(next);
    setConfig(next);
  }, []);

  const disconnect = useCallback(() => {
    hostRef.current?.stop();
    hostRef.current = null;
    clearSyncConfig();
    setConfig(null);
    setStatus({ kind: "idle" });
  }, []);

  const value = useMemo<SyncContextValue>(
    () => ({
      config,
      status,
      canSync,
      dialogOpen,
      setDialogOpen,
      save,
      disconnect,
      testConnection: testSyncConnection,
    }),
    [config, status, canSync, dialogOpen, save, disconnect],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
