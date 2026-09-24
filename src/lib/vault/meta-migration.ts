import { LEGACY_META_DIRS, META_DIR } from "@/lib/core/paths";
import type { VaultFileSystem } from "@/lib/vault/fs";
import { copyTreeVerified, deleteTree, listFiles } from "@/lib/vault/tree-copy";

/**
 * Move a vault's metadata directory from a legacy name (`.adhd`) to
 * META_DIR (`.methyl`) on a file system without rename (OPFS).
 *
 * Crash-safe and idempotent:
 *  1. copy every legacy file into META_DIR, overwriting, and read each one
 *     back to verify it;
 *  2. write a marker in META_DIR saying the copy is complete;
 *  3. delete the legacy files.
 * Interrupted in (1), the legacy directory is untouched and the copy simply
 * runs again. Interrupted in (3), the marker says the copy already
 * finished, so a rerun only finishes deleting — it never copies stale
 * legacy files over data the app has written since.
 */
const MARKER = (legacy: string) => `${META_DIR}/vault-meta/migrated-from${legacy}`;

export interface MetaMigrationReport {
  migrated: string[];
  files: number;
}

export async function migrateLegacyMetaDir(fs: VaultFileSystem): Promise<MetaMigrationReport> {
  const report: MetaMigrationReport = { migrated: [], files: 0 };
  for (const legacy of LEGACY_META_DIRS) {
    const files = await listFiles(fs, legacy);
    if (files.length === 0 && !(await fs.exists(MARKER(legacy)))) continue;

    if (!(await fs.exists(MARKER(legacy)))) {
      report.files += await copyTreeVerified(fs, legacy, META_DIR);
      await fs.writeFile(MARKER(legacy), new TextEncoder().encode(new Date().toISOString()));
    }

    if (files.length === 0) continue;
    await deleteTree(fs, legacy);
    report.migrated.push(legacy);
  }
  return report;
}
