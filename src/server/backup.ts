import { promises as fs } from "fs";
import { join, relative } from "path";
import Database from "better-sqlite3";

/**
 * Server backup and restore (spec item 2).
 *
 *   node dist/server.cjs backup  <destination-dir>
 *   node dist/server.cjs restore <backup-dir>
 *
 * Backup copies the whole vault folder — notes, attachments and the
 * `.adhd/` metadata — and takes the sync database through SQLite's online
 * backup API, so it is consistent even while the server is running and
 * writing. Restore copies a backup into an empty vault folder; it refuses
 * to overwrite one that already has content, so it can't clobber a live
 * vault by accident.
 */

const SYNC_DB = join(".adhd", "server", "sync.sqlite");

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(dir, entry.name));
    else count += 1;
  }
  return count;
}

export async function backupVault(vaultPath: string, destination: string): Promise<{ files: number }> {
  if (!(await isEmptyOrMissing(destination))) {
    throw new Error(`backup destination ${destination} is not empty`);
  }
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(vaultPath, destination, {
    recursive: true,
    // The live database (and its WAL/SHM side files) is copied below
    // through the backup API instead of byte-for-byte mid-write.
    filter: (source) => {
      const rel = relative(vaultPath, source);
      return rel !== SYNC_DB && !rel.startsWith(`${SYNC_DB}-`) && !source.endsWith(".tmp");
    },
  });
  try {
    await fs.access(join(vaultPath, SYNC_DB));
    const db = new Database(join(vaultPath, SYNC_DB), { fileMustExist: true });
    try {
      await fs.mkdir(join(destination, ".adhd", "server"), { recursive: true });
      await db.backup(join(destination, SYNC_DB));
    } finally {
      db.close();
    }
  } catch (error) {
    // A vault that has never been synced has no database: nothing to copy.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { files: await countFiles(destination) };
}

export async function restoreVault(backupPath: string, vaultPath: string): Promise<{ files: number }> {
  await fs.access(backupPath);
  if (!(await isEmptyOrMissing(vaultPath))) {
    throw new Error(
      `vault folder ${vaultPath} is not empty; restore only into an empty folder (stop the server and move the old vault aside first)`,
    );
  }
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.cp(backupPath, vaultPath, { recursive: true });
  return { files: await countFiles(vaultPath) };
}

/** `backup`/`restore` subcommands of the server entry point. Returns an exit code. */
export async function runBackupCommand(command: string, args: string[], vaultPath: string): Promise<number> {
  const target = args[0];
  if (!target) {
    console.error(`usage: server.cjs ${command} <${command === "backup" ? "destination" : "backup"}-dir>`);
    return 2;
  }
  try {
    if (command === "backup") {
      const { files } = await backupVault(vaultPath, target);
      console.log(`[methyl] backed up ${vaultPath} to ${target} (${files} files)`);
    } else {
      const { files } = await restoreVault(target, vaultPath);
      console.log(`[methyl] restored ${target} into ${vaultPath} (${files} files)`);
    }
    return 0;
  } catch (error) {
    console.error(`[methyl] ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
