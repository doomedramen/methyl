import type { VaultFileSystem } from "@/lib/vault/fs";
import { copyTreeVerified, deleteTree, listFiles } from "@/lib/vault/tree-copy";

/**
 * The browser's list of vaults (spec item 9). Each vault lives in its own
 * OPFS directory, `methyl/vaults/<id>/`; this registry — one JSON file at
 * `methyl/vaults.json` — records which exist and what they're called.
 * Everything here works on an origin-level VaultFileSystem (rooted at the
 * OPFS root), so it is testable with MemoryVaultFS.
 */

export interface VaultInfo {
  id: string;
  name: string;
  createdAt: number;
}

/** The vault that existed before multi-vault keeps its id, so its sync room and note URLs stay the same. */
export const DEFAULT_VAULT_ID = "local";
const REGISTRY_PATH = "methyl/vaults.json";
const LEGACY_ROOT = "adhd-vault";
const LEGACY_ROOT_MARKER = "methyl/migrated-from-adhd-vault";
const LAST_VAULT_KEY = "methyl.last-vault";
const VAULT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function vaultDir(id: string): string {
  return `methyl/vaults/${id}`;
}

export function isValidVaultId(id: string): boolean {
  return VAULT_ID_RE.test(id);
}

export async function loadRegistry(fs: VaultFileSystem): Promise<VaultInfo[]> {
  const raw = await fs.readTextFile(REGISTRY_PATH);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is VaultInfo =>
        typeof v?.id === "string" && isValidVaultId(v.id) && typeof v.name === "string" && typeof v.createdAt === "number",
    );
  } catch {
    return [];
  }
}

async function saveRegistry(fs: VaultFileSystem, vaults: VaultInfo[]): Promise<void> {
  await fs.writeTextAtomic(REGISTRY_PATH, JSON.stringify(vaults, null, 1));
}

/** Registry changes from different tabs run one at a time. */
async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return fn();
  return locks.request("methyl:registry", () => fn());
}

async function update(fs: VaultFileSystem, change: (vaults: VaultInfo[]) => VaultInfo[]): Promise<VaultInfo[]> {
  return withRegistryLock(async () => {
    const next = change(await loadRegistry(fs));
    await saveRegistry(fs, next);
    return next;
  });
}

export interface LayoutMigrationReport {
  migrated: boolean;
  files: number;
}

/**
 * Move the single pre-multi-vault vault (`adhd-vault/`) to
 * `methyl/vaults/local/` and register it. Same crash-safety scheme as the
 * metadata migration: copy and verify, mark complete, then delete; a rerun
 * after an interrupted delete only finishes deleting. Callers hold the
 * legacy writer lock (LEGACY_WRITER_LOCK_NAME) so an older build's tab
 * can't write the old root meanwhile.
 */
export async function migrateLegacyVaultRoot(fs: VaultFileSystem): Promise<LayoutMigrationReport> {
  const files = await listFiles(fs, LEGACY_ROOT);
  const done = await fs.exists(LEGACY_ROOT_MARKER);
  if (files.length === 0 && !done) return { migrated: false, files: 0 };

  let copied = 0;
  if (!done) {
    copied = await copyTreeVerified(fs, LEGACY_ROOT, vaultDir(DEFAULT_VAULT_ID));
    await update(fs, (vaults) =>
      vaults.some((v) => v.id === DEFAULT_VAULT_ID)
        ? vaults
        : [{ id: DEFAULT_VAULT_ID, name: "My vault", createdAt: Date.now() }, ...vaults],
    );
    await fs.writeFile(LEGACY_ROOT_MARKER, new TextEncoder().encode(new Date().toISOString()));
  }
  if (files.length > 0) await deleteTree(fs, LEGACY_ROOT);
  return { migrated: files.length > 0, files: copied };
}

function lastUsedVault(): string | null {
  try {
    return localStorage.getItem(LAST_VAULT_KEY);
  } catch {
    return null;
  }
}

export function rememberVault(id: string): void {
  try {
    localStorage.setItem(LAST_VAULT_KEY, id);
  } catch {
    // A convenience only.
  }
}

/**
 * Which vault this page opens: the one named by the URL's first path
 * segment, else the last one used, else the first registered. An empty
 * registry gets the default vault.
 */
export async function resolveVault(fs: VaultFileSystem, pathname: string): Promise<VaultInfo> {
  let vaults = await loadRegistry(fs);
  if (vaults.length === 0) {
    vaults = await update(fs, (current) =>
      current.length > 0 ? current : [{ id: DEFAULT_VAULT_ID, name: "My vault", createdAt: Date.now() }],
    );
  }
  const fromUrl = decodeURIComponent(pathname.split("/").filter(Boolean)[0] ?? "");
  const byId = (id: string | null) => (id ? vaults.find((v) => v.id === id) : undefined);
  return byId(fromUrl) ?? byId(lastUsedVault()) ?? vaults[0]!;
}

function newVaultId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createVault(fs: VaultFileSystem, name: string): Promise<VaultInfo> {
  const vault: VaultInfo = { id: newVaultId(), name: name.trim() || "Untitled vault", createdAt: Date.now() };
  await update(fs, (vaults) => [...vaults, vault]);
  return vault;
}

export async function renameVault(fs: VaultFileSystem, id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A vault needs a name");
  await update(fs, (vaults) => vaults.map((v) => (v.id === id ? { ...v, name: trimmed } : v)));
}

/**
 * Remove a vault and everything in it. The caller must hold that vault's
 * writer lock (no tab may have it open). The last vault can't be deleted.
 */
export async function deleteVault(fs: VaultFileSystem, id: string): Promise<void> {
  await withRegistryLock(async () => {
    const vaults = await loadRegistry(fs);
    if (!vaults.some((v) => v.id === id)) return;
    if (vaults.length === 1) throw new Error("The last vault can't be deleted");
    // Unregister first: a crash mid-delete leaves an orphan directory,
    // never a registered vault with half its files.
    await saveRegistry(
      fs,
      vaults.filter((v) => v.id !== id),
    );
  });
  await fs.delete(vaultDir(id), { recursive: true });
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.endsWith(`:${id}`) || key.endsWith(`.${id}`)) localStorage.removeItem(key);
    }
    if (lastUsedVault() === id) localStorage.removeItem(LAST_VAULT_KEY);
  } catch {
    // Per-vault conveniences only.
  }
}

/** Unpack a full backup (path → bytes, as from a ZIP) into a new vault. */
export async function importVaultFiles(
  fs: VaultFileSystem,
  name: string,
  files: Record<string, Uint8Array>,
): Promise<VaultInfo> {
  const vault = await createVault(fs, name);
  for (const [path, bytes] of Object.entries(files)) {
    if (path.endsWith("/") || path.split("/").includes("..")) continue;
    await fs.writeFile(`${vaultDir(vault.id)}/${path}`, bytes);
  }
  return vault;
}
