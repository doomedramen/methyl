"use client";

/**
 * Wires sync hosts into the app lifecycle (SPEC §18-§34):
 *   - Starts one host per local vault only when this tab holds its writer
 *     lock (§12) — a second tab must not duplicate a connection.
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
import type { VaultSyncFleet } from "@/lib/browser/sync-fleet";
import type { SyncStatus } from "@/lib/browser/sync-host";
import type { SyncReport } from "@/lib/sync/coordinator";
import {
  clearSyncConfig,
  fetchServerVersion,
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
  /** The sync server's version, once known. */
  serverVersion: string | null;
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
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const fleetRef = useRef<VaultSyncFleet | null>(null);
  const onRemoteChangeRef = useRef(onRemoteChange);
  useEffect(() => {
    onRemoteChangeRef.current = onRemoteChange;
  }, [onRemoteChange]);

  useEffect(() => {
    if (!engine) return;
    // localStorage only exists in the browser, so the saved config is read
    // after hydration rather than during the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig(loadSyncConfig(engine.vaultId));
  }, [engine]);

  // Sync setup is shared by every tab on this origin. A change in one tab
  // starts, switches or stops the fleet in the others too.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== "methyl.sync-config" && !event.key.startsWith("methyl.sync-config:")) return;
      setConfig(loadSyncConfig(engine?.vaultId));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
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
    if (!config?.authToken) return;
    let cancelled = false;
    const { authToken, ...rest } = config;
    void pairDevice({ serverUrl: config.serverUrl, adminToken: authToken })
      .then((result) => {
        saveSyncConfig(rest);
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
  }, [config]);

  // Start/stop the shared vault fleet when writer access or server config changes.
  useEffect(() => {
    let cancelled = false;
    if (!engine || !config || config.authToken) return;

    // Reset before the async start below; the host reports its own status
    // from then on.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(canSync ? { kind: "connecting" } : { kind: "idle" });

    import("@/lib/browser/sync-fleet")
      .then(({ VaultSyncFleet }) => {
        if (cancelled) return;
        const fleet = new VaultSyncFleet({
          config,
          activeVaultId: engine.vaultId,
          activeEngine: engine,
          onActiveStatus: setStatus,
          onBackgroundError: (vaultName, message) => {
            setStatus({ kind: "error", message: `Background sync for "${vaultName}" failed: ${message}` });
          },
          onRemoteChange: (report) => onRemoteChangeRef.current?.(report),
        });
        if (cancelled) return;
        fleetRef.current = fleet;
        fleet.start();
      })
      .catch((err) => {
        console.error("[sync] failed to start vault sync fleet", err);
        if (!cancelled) setStatus({ kind: "error", message: String(err) });
      });

    return () => {
      cancelled = true;
      fleetRef.current?.stop();
      fleetRef.current = null;
      setStatus({ kind: "idle" });
    };
  }, [canSync, engine, config]);

  // The server's version, to show it and warn when it and the app differ.
  // Re-read after each successful round: the server may have been updated.
  const synced = status.kind === "synced";
  useEffect(() => {
    let cancelled = false;
    const url = config?.serverUrl;
    if (!url) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setServerVersion(null);
      return;
    }
    void fetchServerVersion(url).then((version) => {
      if (!cancelled) setServerVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, [config?.serverUrl, synced]);

  const save = useCallback((next: SyncConfig) => {
    saveSyncConfig(next);
    setConfig(next);
  }, []);

  const disconnect = useCallback(() => {
    fleetRef.current?.stop();
    fleetRef.current = null;
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
      serverVersion,
    }),
    [config, status, canSync, dialogOpen, save, disconnect, serverVersion],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
