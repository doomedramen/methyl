import { unzipSync } from "fflate";
import { getCurrentVault, originFileSystem } from "@/lib/browser/vault";
import {
  createVault,
  deleteVault,
  importVaultFiles,
  loadRegistry,
  renameVault,
  type VaultInfo,
} from "@/lib/browser/vault-registry";
import { acquireVaultWriterLock } from "@/lib/vault/web-locks";

/**
 * What the vault switcher and "Manage vaults" dialog do (spec item 9).
 * Loaded dynamically by those components, since it pulls in the vault
 * engine. Opening another vault is a full page load of its URL: every
 * piece of per-vault state starts clean.
 */

export type { VaultInfo };

export async function listVaults(): Promise<{ vaults: VaultInfo[]; current: VaultInfo | null }> {
  return { vaults: await loadRegistry(originFileSystem()), current: getCurrentVault() };
}

export function openVault(id: string): void {
  // A full page load, deliberately: the engine, locks, sync host and every
  // per-vault store are opened once per page, so nothing carries over.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/${encodeURIComponent(id)}/`);
}

export async function createAndOpenVault(name: string): Promise<void> {
  const vault = await createVault(originFileSystem(), name);
  openVault(vault.id);
}

export async function renameVaultTo(id: string, name: string): Promise<void> {
  await renameVault(originFileSystem(), id, name);
}

/**
 * Delete a vault that isn't open here. Refused while any tab has it open:
 * taking its writer lock is how that's checked, and holding it through the
 * delete keeps a tab from opening it meanwhile.
 */
export async function removeVault(id: string): Promise<void> {
  if (getCurrentVault()?.id === id) throw new Error("Switch to another vault before deleting this one");
  const lock = await acquireVaultWriterLock(id);
  if (!lock.active) throw new Error("That vault is open in another tab; close it there first");
  try {
    await deleteVault(originFileSystem(), id);
  } finally {
    lock.release();
  }
}

/**
 * Restore a full backup ZIP ("Export full backup") as a new vault, then
 * open it. The metadata inside keeps note identity and history; a backup
 * made before the rename (`.adhd/`) is migrated when the vault opens.
 */
export async function importBackupAsVault(file: File, name: string): Promise<void> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const vault = await importVaultFiles(originFileSystem(), name, files);
  openVault(vault.id);
}
