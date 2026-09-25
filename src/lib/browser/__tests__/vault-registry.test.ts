import { beforeEach, describe, expect, it } from "vitest";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import type { VaultFileSystem } from "@/lib/vault/fs";
import {
  DEFAULT_VAULT_ID,
  createVault,
  deleteVault,
  ensureVaultSyncIds,
  importVaultFiles,
  loadRegistry,
  markVaultArchived,
  markVaultRestored,
  migrateLegacyVaultRoot,
  rememberVault,
  renameVault,
  resolveVault,
  vaultDir,
} from "@/lib/browser/vault-registry";

const text = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no localStorage in this environment
  }
});

describe("layout migration (adhd-vault → methyl/vaults/local)", () => {
  async function legacyOrigin() {
    const fs = new MemoryVaultFS();
    await fs.writeFile("adhd-vault/Home.md", text("home\n"));
    await fs.writeFile("adhd-vault/.adhd/crdt/vault/snapshot.loro", text("tree"));
    return fs;
  }

  it("moves the old vault into place and registers it", async () => {
    const fs = await legacyOrigin();
    const report = await migrateLegacyVaultRoot(fs);
    expect(report).toEqual({ migrated: true, files: 2 });
    expect(await fs.readTextFile(`${vaultDir(DEFAULT_VAULT_ID)}/Home.md`)).toBe("home\n");
    expect(await fs.readTextFile(`${vaultDir(DEFAULT_VAULT_ID)}/.adhd/crdt/vault/snapshot.loro`)).toBe("tree");
    expect((await fs.readdir("adhd-vault")).files).toEqual([]);
    expect((await loadRegistry(fs)).map((v) => v.id)).toEqual([DEFAULT_VAULT_ID]);
    expect(await migrateLegacyVaultRoot(fs)).toEqual({ migrated: false, files: 0 });
  });

  it("an interrupted delete is finished without copying stale files over newer ones", async () => {
    const fs = await legacyOrigin();
    let deletes = 0;
    const failing: VaultFileSystem = Object.create(fs);
    failing.delete = async (path: string, options?: { recursive?: boolean }) => {
      if (++deletes === 2) throw new Error("tab closed");
      return fs.delete(path, options);
    };
    await expect(migrateLegacyVaultRoot(failing)).rejects.toThrow("tab closed");
    await fs.writeFile(`${vaultDir(DEFAULT_VAULT_ID)}/Home.md`, text("edited after the move\n"));
    await migrateLegacyVaultRoot(fs);
    expect(await fs.readTextFile(`${vaultDir(DEFAULT_VAULT_ID)}/Home.md`)).toBe("edited after the move\n");
    expect((await fs.readdir("adhd-vault")).files).toEqual([]);
  });

  it("does nothing on a fresh browser", async () => {
    expect(await migrateLegacyVaultRoot(new MemoryVaultFS())).toEqual({ migrated: false, files: 0 });
  });
});

describe("vault registry", () => {
  it("resolves the vault from the URL, then the last one used, creating the default when empty", async () => {
    const fs = new MemoryVaultFS();
    expect((await resolveVault(fs, "/")).id).toBe(DEFAULT_VAULT_ID);
    const work = await createVault(fs, "Work");
    expect((await resolveVault(fs, `/${work.id}/Plans.md`)).id).toBe(work.id);
    expect((await resolveVault(fs, "/unknown-vault/x.md")).id).toBe(DEFAULT_VAULT_ID);
    rememberVault(work.id);
    expect((await resolveVault(fs, "/")).id).toBe(typeof localStorage === "undefined" ? DEFAULT_VAULT_ID : work.id);
  });

  it("creates, renames and deletes vaults; the last one stays", async () => {
    const fs = new MemoryVaultFS();
    await resolveVault(fs, "/");
    const work = await createVault(fs, "  Work  ");
    expect(work.name).toBe("Work");
    expect(work.syncId).toBe("work");
    await fs.writeFile(`${vaultDir(work.id)}/note.md`, text("x"));
    await renameVault(fs, work.id, "Job");
    expect((await loadRegistry(fs)).find((v) => v.id === work.id)?.name).toBe("Job");
    await expect(renameVault(fs, work.id, "   ")).rejects.toThrow(/name/);

    await deleteVault(fs, work.id);
    expect((await loadRegistry(fs)).map((v) => v.id)).toEqual([DEFAULT_VAULT_ID]);
    expect(await fs.exists(`${vaultDir(work.id)}/note.md`)).toBe(false);
    await expect(deleteVault(fs, DEFAULT_VAULT_ID)).rejects.toThrow(/last vault/);
  });

  it("assigns stable server IDs to older local vaults", async () => {
    const fs = new MemoryVaultFS();
    await resolveVault(fs, "/");
    const oldVault = await createVault(fs, "Personal Notes");
    const unboundRegistry = await loadRegistry(fs);
    await fs.writeTextAtomic("methyl/vaults.json", JSON.stringify(unboundRegistry.map(({ syncId: _syncId, ...vault }) => vault)));

    const assigned = await ensureVaultSyncIds(fs, { [DEFAULT_VAULT_ID]: "legacy-default", [oldVault.id]: "personal" });
    expect(assigned.find((vault) => vault.id === DEFAULT_VAULT_ID)?.syncId).toBe("legacy-default");
    expect(assigned.find((vault) => vault.id === oldVault.id)?.syncId).toBe("personal");
  });

  it("keeps archived vault files but does not reopen them from their old URL", async () => {
    const fs = new MemoryVaultFS();
    const home = await resolveVault(fs, "/");
    const work = await createVault(fs, "Work");
    await fs.writeFile(`${vaultDir(work.id)}/Note.md`, text("preserved"));

    await markVaultArchived(fs, work.id, 1234);

    expect((await loadRegistry(fs)).find((vault) => vault.id === work.id)?.archivedAt).toBe(1234);
    expect(await fs.readTextFile(`${vaultDir(work.id)}/Note.md`)).toBe("preserved");
    expect((await resolveVault(fs, `/${work.id}/Note.md`)).id).toBe(home.id);

    await markVaultRestored(fs, work.id);
    expect((await loadRegistry(fs)).find((vault) => vault.id === work.id)?.archivedAt).toBeUndefined();
    expect((await resolveVault(fs, `/${work.id}/Note.md`)).id).toBe(work.id);
  });

  it("imports a backup's files into a new vault, ignoring unsafe paths", async () => {
    const fs = new MemoryVaultFS();
    const vault = await importVaultFiles(fs, "Restored", {
      "Home.md": text("home"),
      ".methyl/index.json": text("{}"),
      "../escape.md": text("no"),
      "Folder/": new Uint8Array(),
    });
    expect(await fs.readTextFile(`${vaultDir(vault.id)}/Home.md`)).toBe("home");
    expect(await fs.readTextFile(`${vaultDir(vault.id)}/.methyl/index.json`)).toBe("{}");
    expect(await fs.exists("methyl/vaults/escape.md")).toBe(false);
  });
});
