import { existsSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { LEGACY_META_DIRS, META_DIR } from "@/lib/core/paths";

/**
 * Rename a server vault's legacy metadata directory (`.adhd`) to META_DIR
 * (`.methyl`) — one atomic rename on the same file system. If both exist
 * the server refuses to open the vault rather than guess which is current.
 */
export function migrateLegacyMetaDirOnDisk(vaultPath: string): string[] {
  const migrated: string[] = [];
  for (const legacy of LEGACY_META_DIRS) {
    const from = join(vaultPath, legacy);
    if (!existsSync(from)) continue;
    const to = join(vaultPath, META_DIR);
    if (existsSync(to) && readdirSync(to).length > 0) {
      throw new Error(
        `vault ${vaultPath} has both ${legacy}/ and ${META_DIR}/. ${META_DIR}/ is current; ` +
          `move ${legacy}/ out of the vault (keep it as a backup) and start again.`,
      );
    }
    renameSync(from, to);
    migrated.push(legacy);
    console.log(`[methyl] renamed ${from} to ${to}`);
  }
  return migrated;
}
