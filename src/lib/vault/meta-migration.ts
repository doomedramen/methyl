import { LEGACY_META_DIRS, META_DIR } from "@/lib/core/paths";
import type { VaultFileSystem } from "@/lib/vault/fs";

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

async function listFiles(fs: VaultFileSystem, dir: string): Promise<string[]> {
  const { dirs, files } = await fs.readdir(dir);
  const out = files.map((name) => `${dir}/${name}`);
  for (const name of dirs) out.push(...(await listFiles(fs, `${dir}/${name}`)));
  return out;
}

async function listDirs(fs: VaultFileSystem, dir: string): Promise<string[]> {
  const { dirs } = await fs.readdir(dir);
  const out: string[] = [];
  for (const name of dirs) {
    const child = `${dir}/${name}`;
    out.push(...(await listDirs(fs, child)), child);
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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
      for (const source of files) {
        const bytes = await fs.readFile(source);
        if (!bytes) continue;
        const target = META_DIR + source.slice(legacy.length);
        await fs.writeFile(target, bytes);
        const copied = await fs.readFile(target);
        if (!copied || !sameBytes(copied, bytes)) {
          throw new Error(`metadata migration: ${target} did not read back as written; ${legacy} left untouched`);
        }
      }
      await fs.writeFile(MARKER(legacy), new TextEncoder().encode(new Date().toISOString()));
      report.files += files.length;
    }

    if (files.length === 0) continue;
    for (const source of files) await fs.delete(source);
    for (const dir of await listDirs(fs, legacy)) await fs.delete(dir);
    await fs.delete(legacy).catch(() => undefined);
    report.migrated.push(legacy);
  }
  return report;
}
