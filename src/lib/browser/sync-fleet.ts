"use client";

import { migrateLegacyMetaDir } from "@/lib/vault/meta-migration";
import { OpfsVaultFS, vaultRootParts } from "@/lib/vault/opfs";
import { WriterGatedFS } from "@/lib/vault/gated-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import {
  acquireVaultWriterLock,
  onBackgroundSyncYieldRequest,
  type VaultLock,
} from "@/lib/vault/web-locks";
import { originFileSystem, getVaultFileSystem } from "@/lib/browser/vault";
import {
  ensureVaultSyncIds,
  markVaultArchived,
  markVaultRestored,
  registerRemoteVault,
  type VaultInfo,
} from "@/lib/browser/vault-registry";
import {
  ensureServerVault,
  fetchSyncTicket,
  getPairing,
  listServerVaults,
  loadLegacyVaultSyncIds,
  type SyncConfig,
} from "@/lib/browser/sync-config";
import { SyncHost, type SyncStatus } from "@/lib/browser/sync-host";
import { TREE_VAULT_ID } from "@/lib/sync/rooms";
import type { VaultFileSystem } from "@/lib/vault/fs";
import type { SyncReport } from "@/lib/sync/coordinator";

const RECONCILE_INTERVAL_MS = 30_000;

interface HostEntry {
  vault: VaultInfo;
  host: SyncHost;
  fs: VaultFileSystem;
  lock?: VaultLock;
}

export interface VaultSyncFleetOptions {
  config: SyncConfig;
  activeVaultId: string;
  activeEngine: VaultEngine;
  onActiveStatus: (status: SyncStatus) => void;
  onBackgroundError: (vaultName: string, message: string) => void;
  onRemoteChange?: (report: SyncReport) => void;
}

const fleets = new Set<VaultSyncFleet>();

/** Start one host for every local vault, including vaults not open in this tab. */
export class VaultSyncFleet {
  private readonly entries = new Map<string, HostEntry>();
  private readonly blockedVaultIds = new Set<string>();
  private readonly yieldRequests = new Set<string>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private stopped = false;
  private readonly activeFs: VaultFileSystem;
  private stopYieldListener: (() => void) | null = null;

  constructor(private readonly options: VaultSyncFleetOptions) {
    this.activeFs = getVaultFileSystem();
  }

  start(): void {
    fleets.add(this);
    void this.reconcile();
    this.interval = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    this.stopYieldListener = onBackgroundSyncYieldRequest((vaultId) => this.yieldVaultForForeground(vaultId));
    window.addEventListener("online", this.kickAll);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.stop, { once: true });
  }

  stop = (): void => {
    if (this.stopped) return;
    this.stopped = true;
    fleets.delete(this);
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.stopYieldListener?.();
    this.stopYieldListener = null;
    window.removeEventListener("online", this.kickAll);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.stop);
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
  };

  /** Stop sync before a local vault is removed; do not restart it this page. */
  stopVaultForDelete(vaultId: string): void {
    this.blockedVaultIds.add(vaultId);
    const entry = this.entries.get(vaultId);
    if (!entry) return;
    this.disposeEntry(entry);
    this.entries.delete(vaultId);
  }

  resumeVaultAfterFailedArchive(vaultId: string): void {
    this.blockedVaultIds.delete(vaultId);
    void this.reconcile();
  }

  private yieldVaultForForeground(vaultId: string): void {
    this.yieldRequests.add(vaultId);
    const entry = this.entries.get(vaultId);
    if (!entry?.lock) {
      if (!this.reconciling) this.yieldRequests.delete(vaultId);
      return;
    }
    this.disposeEntry(entry);
    this.entries.delete(vaultId);
    if (!this.reconciling) this.yieldRequests.delete(vaultId);
  }

  private kickAll = (): void => {
    for (const entry of this.entries.values()) entry.host.kick();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === "visible") this.kickAll();
  };

  private async reconcile(): Promise<void> {
    if (this.stopped || this.reconciling) return;
    this.reconciling = true;
    try {
      const pairing = await getPairing(this.options.config.serverUrl);
      if (!pairing.paired) {
        this.options.onActiveStatus({ kind: "error", message: pairing.error ?? "Pair this browser with the sync server." });
        return;
      }
      if (pairing.device.vaults !== "*") {
        this.options.onActiveStatus({
          kind: "error",
          message: "Enter the server admin token in Sync settings to grant this browser access to every vault.",
        });
        return;
      }

      const origin = originFileSystem();
      let vaults = await ensureVaultSyncIds(origin, loadLegacyVaultSyncIds());
      const listed = await listServerVaults(this.options.config);
      if (!listed.ok) {
        this.options.onActiveStatus({ kind: "error", message: listed.error });
        return;
      }

      const archivedSyncIds = new Set(listed.archivedVaults);
      const activeSyncIds = new Set(listed.vaults);
      for (const vault of vaults) {
        if (!vault.syncId) continue;
        if (archivedSyncIds.has(vault.syncId) && !vault.archivedAt) {
          await markVaultArchived(origin, vault.id);
          const entry = this.entries.get(vault.id);
          if (entry) {
            this.disposeEntry(entry);
            this.entries.delete(vault.id);
          }
          if (vault.id === this.options.activeVaultId) {
            this.options.onActiveStatus({ kind: "error", message: "This vault was archived on the sync server." });
          }
        } else if (vault.archivedAt && activeSyncIds.has(vault.syncId)) {
          await markVaultRestored(origin, vault.id);
        }
      }
      vaults = await ensureVaultSyncIds(origin, loadLegacyVaultSyncIds());

      const knownSyncIds = new Set(vaults.map((vault) => vault.syncId));
      for (const remoteId of listed.vaults) {
        if (!knownSyncIds.has(remoteId)) await registerRemoteVault(origin, remoteId);
      }
      vaults = await ensureVaultSyncIds(origin, loadLegacyVaultSyncIds());

      const remoteIds = new Set(listed.vaults);
      for (const vault of vaults) {
        if (vault.archivedAt) continue;
        if (!vault.syncId || remoteIds.has(vault.syncId)) continue;
        const result = await ensureServerVault({ serverUrl: this.options.config.serverUrl, id: vault.syncId });
        if (result.ok) remoteIds.add(vault.syncId);
        else if (!this.stopped) this.options.onBackgroundError(vault.name, result.error);
      }

      const localIds = new Set(vaults.map((vault) => vault.id));
      for (const [vaultId, entry] of this.entries) {
        if (!localIds.has(vaultId) || entry.vault.archivedAt || this.blockedVaultIds.has(vaultId)) {
          this.disposeEntry(entry);
          this.entries.delete(vaultId);
        }
      }

      for (const vault of vaults) {
        if (
          this.stopped ||
          vault.archivedAt ||
          this.entries.has(vault.id) ||
          this.blockedVaultIds.has(vault.id) ||
          this.yieldRequests.has(vault.id)
        ) continue;
        if (!vault.syncId) continue;
        let opened: { engine: VaultEngine; fs: VaultFileSystem; lock?: VaultLock } | null = null;
        try {
          const active = vault.id === this.options.activeVaultId;
          opened = active
            ? this.openActiveVault(vault)
            : await this.openBackgroundVault(vault);
          if (!opened) continue;
          if (this.stopped || this.blockedVaultIds.has(vault.id) || this.yieldRequests.has(vault.id)) {
            if (opened.lock) (opened.fs as WriterGatedFS).setWritable(false);
            opened.lock?.release();
            continue;
          }
          const { wsUrl, apiUrl } = await import("@/lib/browser/sync-config").then(({ deriveSyncUrls }) =>
            deriveSyncUrls(this.options.config.serverUrl, vault.syncId),
          );
          const host = await SyncHost.create({
            fs: opened.fs,
            engine: opened.engine,
            wsUrl,
            apiUrl,
            getJoinAuth: () => fetchSyncTicket(this.options.config.serverUrl, vault.syncId),
            vaultId: TREE_VAULT_ID,
          });
          if (this.stopped) {
            host.stop();
            if (opened.lock) (opened.fs as WriterGatedFS).setWritable(false);
            opened.lock?.release();
            continue;
          }
          if (this.blockedVaultIds.has(vault.id) || this.yieldRequests.has(vault.id)) {
            host.stop();
            if (opened.lock) (opened.fs as WriterGatedFS).setWritable(false);
            opened.lock?.release();
            continue;
          }
          host.onStatusChange((status) => {
            if (active) this.options.onActiveStatus(status);
            else if (status.kind === "error") this.options.onBackgroundError(vault.name, status.message);
          });
          if (active && this.options.onRemoteChange) host.onRemoteChange(this.options.onRemoteChange);
          host.start();
          this.entries.set(vault.id, { vault, host, fs: opened.fs, ...(opened.lock ? { lock: opened.lock } : {}) });
          if (active) this.options.onActiveStatus(host.status.kind === "idle" ? { kind: "connecting" } : host.status);
        } catch (error) {
          opened?.lock?.release();
          const message = error instanceof Error ? error.message : String(error);
          if (vault.id === this.options.activeVaultId) this.options.onActiveStatus({ kind: "error", message });
          else this.options.onBackgroundError(vault.name, message);
        }
      }
    } catch (error) {
      if (!this.stopped) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.onActiveStatus({ kind: "error", message });
      }
    } finally {
      this.reconciling = false;
      this.yieldRequests.clear();
    }
  }

  private openActiveVault(vault: VaultInfo): { engine: VaultEngine; fs: VaultFileSystem } | null {
    if (!this.options.activeEngine.releaseWriterLock || !vault.syncId) return null;
    return { engine: this.options.activeEngine, fs: this.activeFs };
  }

  private async openBackgroundVault(vault: VaultInfo): Promise<{
    engine: VaultEngine;
    fs: WriterGatedFS;
    lock: VaultLock;
  } | null> {
    const lock = await acquireVaultWriterLock(vault.id);
    if (!lock.active) return null;
    const fs = new WriterGatedFS(new OpfsVaultFS(vaultRootParts(vault.id)));
    try {
      fs.setWritable(true);
      await migrateLegacyMetaDir(fs);
      const treeStore = new OpfsVaultTreeStore(fs);
      const docStore = new OpfsDocStore(fs);
      const snapshot = await treeStore.loadSnapshot();
      const updates = snapshot ? [] : await treeStore.loadUpdates();
      let engine: VaultEngine;
      if (snapshot || updates.length > 0) {
        engine = (await VaultEngine.open(treeStore, docStore, vault.id, { lazyDocuments: true })).engine;
      } else {
        engine = await VaultEngine.create(treeStore, docStore, vault.id);
        await engine.reconcileMaterialization();
      }
      engine.releaseWriterLock = () => lock.release();
      return { engine, fs, lock };
    } catch (error) {
      fs.setWritable(false);
      lock.release();
      throw error;
    }
  }

  private disposeEntry(entry: HostEntry): void {
    entry.host.stop();
    if (entry.lock) (entry.fs as WriterGatedFS).setWritable(false);
    entry.lock?.release();
  }
}

/** A vault can be deleted only after any same-tab background host releases its writer lock. */
export async function stopBackgroundSyncForVault(vaultId: string): Promise<void> {
  for (const fleet of fleets) fleet.stopVaultForDelete(vaultId);
}

/** Resume a vault when its archive request fails before it is hidden locally. */
export function resumeBackgroundSyncForVault(vaultId: string): void {
  for (const fleet of fleets) fleet.resumeVaultAfterFailedArchive(vaultId);
}
