import type { VaultFileSystem } from "@/lib/vault/fs";

/**
 * Directory-tree helpers for migrations on file systems without rename
 * (OPFS): copy with read-back verification, then delete.
 */

export async function listFiles(fs: VaultFileSystem, dir: string): Promise<string[]> {
  const { dirs, files } = await fs.readdir(dir);
  const prefix = dir ? `${dir}/` : "";
  const out = files.map((name) => `${prefix}${name}`);
  for (const name of dirs) out.push(...(await listFiles(fs, `${prefix}${name}`)));
  return out;
}

/** Subdirectories of `dir`, deepest first (so they can be removed in order). */
export async function listDirs(fs: VaultFileSystem, dir: string): Promise<string[]> {
  const { dirs } = await fs.readdir(dir);
  const prefix = dir ? `${dir}/` : "";
  const out: string[] = [];
  for (const name of dirs) {
    const child = `${prefix}${name}`;
    out.push(...(await listDirs(fs, child)), child);
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Copy every file under `from` to the same relative path under `to`,
 * overwriting, and read each back to verify it. Throws — leaving `from`
 * untouched — if any file doesn't read back as written. Returns the number
 * of files copied.
 */
export async function copyTreeVerified(fs: VaultFileSystem, from: string, to: string): Promise<number> {
  const files = await listFiles(fs, from);
  for (const source of files) {
    const bytes = await fs.readFile(source);
    if (!bytes) continue;
    const target = to + source.slice(from.length);
    await fs.writeFile(target, bytes);
    const copied = await fs.readFile(target);
    if (!copied || !sameBytes(copied, bytes)) {
      throw new Error(`copy: ${target} did not read back as written; ${from} left untouched`);
    }
  }
  return files.length;
}

/** Delete every file and directory under `dir`, then `dir` itself. */
export async function deleteTree(fs: VaultFileSystem, dir: string): Promise<void> {
  for (const file of await listFiles(fs, dir)) await fs.delete(file);
  for (const sub of await listDirs(fs, dir)) await fs.delete(sub);
  await fs.delete(dir).catch(() => undefined);
}
