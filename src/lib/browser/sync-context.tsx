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
import { TREE_VAULT_ID } from "@/lib/sync/rooms";
import {
  clearSyncConfig,
  deriveSyncUrls,
  fetchSyncTicket,
  loadSyncConfig,
  pairDevice,
  saveSyncConfig,
  testSyncConnection,
  type SyncConfig,
} from "@/lib/browser/sync-config";


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
  useEffect(() => {
    onRemoteChangeRef.current = onRemoteChange;
  }, [onRemoteChange]);

  useEffect(() => {
    // localStorage only exists in the browser, so the saved config is read
    // after hydration rather than during the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig(engine ? loadSyncConfig(engine.vaultId) : null);
  }, [engine]);

  // A read-only tab is promoted to writer in place (§12) — the `engine`
  // reference doesn't change, only its `releaseWriterLock` field — so
  // re-render on every access-status change rather than reading
  // `engine.releaseWriterLock` only once per engine identity. Without this,
  // SyncHost would only ever start after a remount (i.e. a reload), which
  // is exactly the reload-to-recover-writer behavior promotion replaces.
  const [, forceAccessTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    import("@/lib/browser/vault").then(({ onVaultAccessStatusChange }) => {
      if (cancelled) return;
      cleanup = onVaultAccessStatusChange(() => forceAccessTick((t) => t + 1));
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  const canSync = !!engine && !!engine.releaseWriterLock;

  // A config saved before device pairing holds the admin token. Pair this
  // browser with it once, then drop it from localStorage either way (spec
  // item 5); if pairing fails, ask for the token again in Sync settings.
  useEffect(() => {
    if (!engine || !config?.authToken) return;
    let cancelled = false;
    const { authToken, ...rest } = config;
    void pairDevice({ serverUrl: config.serverUrl, adminToken: authToken, remoteVaultId: config.remoteVaultId })
      .then((result) => {
        saveSyncConfig(rest, engine.vaultId);
        if (cancelled) return;
        setConfig(rest);
        if (!result.ok) {
          setStatus({ kind: "error", message: `Pair this browser again: ${result.error}` });
          setDialogOpen(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [engine, config]);

  // Start/stop the host whenever the engine becomes syncable or config changes.
  useEffect(() => {
    let cancelled = false;
    // A stored token is migrated to pairing first (above).
    if (!canSync || !engine || !config || config.authToken) return;

    // Reset before the async start below; the host reports its own status
    // from then on.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus({ kind: "connecting" });

    Promise.all([import("@/lib/browser/vault"), import("@/lib/browser/sync-host")])
      .then(async ([{ getVaultFileSystem }, { SyncHost }]) => {
        if (cancelled) return;
        // The vault's own file system: writer-lock gated, one write queue.
        const fs = getVaultFileSystem();
        const { wsUrl, apiUrl } = deriveSyncUrls(config.serverUrl, config.remoteVaultId);
        const host = await SyncHost.create({
          fs,
          engine,
          wsUrl,
          apiUrl,
          // HTTP calls carry the device cookie; each round's socket joins
          // with a fresh ticket.
          getJoinAuth: () => fetchSyncTicket(config.serverUrl, config.remoteVaultId),
          // The server vault's tree room, whatever this vault's local id.
          vaultId: TREE_VAULT_ID,
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
      setStatus({ kind: "idle" });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSync, engine, config?.serverUrl, config?.remoteVaultId, config?.authToken]);

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
    if (engine) saveSyncConfig(next, engine.vaultId);
    setConfig(next);
  }, [engine]);

  const disconnect = useCallback(() => {
    hostRef.current?.stop();
    hostRef.current = null;
    if (engine) clearSyncConfig(engine.vaultId);
    setConfig(null);
    setStatus({ kind: "idle" });
  }, [engine]);

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
