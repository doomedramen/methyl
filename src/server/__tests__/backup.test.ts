import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ServerStore } from "@/lib/server/store";
import { backupVault, restoreVault, runBackupCommand } from "../backup";

const dirs: string[] = [];
const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `methyl-${name}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server backup and restore", () => {
  it("copies notes and metadata, and takes the live database through the backup API", async () => {
    const vault = tmp("vault");
    writeFileSync(join(vault, "Home.md"), "home\n");
    mkdirSync(join(vault, ".methyl", "crdt"), { recursive: true });
    writeFileSync(join(vault, ".methyl", "crdt", "state.json"), "{}");
    writeFileSync(join(vault, "Home.md.tmp"), "half");
    // A store held open, as by a running server, with an uncheckpointed WAL.
    const store = new ServerStore(join(vault, ".methyl", "server", "sync.sqlite"));
    store.recordChange(store.getNextSeq(), "doc:a", "doc");

    const backup = join(tmp("backup"), "out");
    await backupVault(vault, backup);
    store.close();

    expect(readFileSync(join(backup, "Home.md"), "utf8")).toBe("home\n");
    expect(existsSync(join(backup, ".methyl", "crdt", "state.json"))).toBe(true);
    expect(existsSync(join(backup, "Home.md.tmp"))).toBe(false);
    expect(existsSync(join(backup, ".methyl", "server", "sync.sqlite-wal"))).toBe(false);
    const copy = new ServerStore(join(backup, ".methyl", "server", "sync.sqlite"));
    expect(copy.getChangesAfter(0).changes.map((c) => c.objectId)).toEqual(["doc:a"]);
    copy.close();
  });

  it("refuses to back up into a non-empty folder or restore over an existing vault", async () => {
    const vault = tmp("vault");
    writeFileSync(join(vault, "Home.md"), "home\n");
    const occupied = tmp("occupied");
    writeFileSync(join(occupied, "keep.txt"), "x");
    await expect(backupVault(vault, occupied)).rejects.toThrow(/not empty/);
    await expect(restoreVault(occupied, vault)).rejects.toThrow(/not empty/);
    expect(readFileSync(join(vault, "Home.md"), "utf8")).toBe("home\n");
  });

  it("restores a backup into an empty vault folder", async () => {
    const vault = tmp("vault");
    writeFileSync(join(vault, "Home.md"), "home\n");
    const backup = join(tmp("backup"), "out");
    await backupVault(vault, backup);
    const fresh = join(tmp("fresh"), "vault");
    await restoreVault(backup, fresh);
    expect(readFileSync(join(fresh, "Home.md"), "utf8")).toBe("home\n");
  });

  it("with a vaults directory, backs up the vault named by --vault", async () => {
    const vaults = tmp("vaults");
    mkdirSync(join(vaults, "work"));
    writeFileSync(join(vaults, "work", "Plan.md"), "plan\n");
    const where = { vaultsPath: vaults, vaultPath: "/unused" };
    const quiet = { log: console.log, error: console.error };
    console.log = console.error = () => {};
    try {
      expect(await runBackupCommand("backup", [join(tmp("x"), "b")], where)).toBe(2);
      expect(await runBackupCommand("backup", ["--vault", "../etc", join(tmp("y"), "b")], where)).toBe(2);
      const dest = join(tmp("dest"), "b");
      expect(await runBackupCommand("backup", ["--vault", "work", dest], where)).toBe(0);
      expect(readFileSync(join(dest, "Plan.md"), "utf8")).toBe("plan\n");
    } finally {
      console.log = quiet.log;
      console.error = quiet.error;
    }
  });
});
