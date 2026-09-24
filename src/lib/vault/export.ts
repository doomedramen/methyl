import { META_DIR } from "@/lib/core/paths";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import type { VaultFileSystem } from "@/lib/vault/fs";

/**
 * Vault export (SPEC §40).
 *
 * - `portable`: the vault's own files — Markdown notes and attachments in
 *   their folders — and nothing else. Opens in any editor; re-importable
 *   through the Obsidian importer.
 * - `full`: the same plus the `.methyl/` metadata directory (CRDT state and
 *   history, the sidecar index), so restoring it keeps note identity and
 *   history.
 *
 * Built with fflate's streaming Zip: each file is read and compressed one
 * at a time, and the archive is handed back as a Blob made of the chunks.
 */
export type ExportMode = "portable" | "full";

const METADATA_DIR = META_DIR;
// Text compresses well; already-compressed media is stored as-is.
const COMPRESSIBLE = /\.(md|markdown|txt|json|csv|svg|html?|css|js|ya?ml|canvas|loro)$/i;

export interface ExportProgress {
  files: number;
  bytes: number;
  path: string;
}

async function* metadataFiles(fs: VaultFileSystem, dir: string): AsyncGenerator<string> {
  const { dirs, files } = await fs.readdir(dir);
  for (const name of files) {
    // Staging files of an in-flight atomic write are not part of the vault.
    if (!name.endsWith(".tmp")) yield `${dir}/${name}`;
  }
  for (const name of dirs) yield* metadataFiles(fs, `${dir}/${name}`);
}

async function* exportPaths(fs: VaultFileSystem, mode: ExportMode): AsyncGenerator<string> {
  for await (const { path } of fs.walk()) {
    if (!path.endsWith(".tmp")) yield path;
  }
  if (mode === "full") yield* metadataFiles(fs, METADATA_DIR);
}

export async function exportVaultZip(
  fs: VaultFileSystem,
  mode: ExportMode,
  onProgress?: (progress: ExportProgress) => void,
): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure = error;
      finished();
      return;
    }
    chunks.push(chunk);
    if (final) finished();
  });

  let files = 0;
  let bytes = 0;
  for await (const path of exportPaths(fs, mode)) {
    const data = await fs.readFile(path);
    if (!data) continue;
    const entry = COMPRESSIBLE.test(path) ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
    zip.add(entry);
    entry.push(data, true);
    files += 1;
    bytes += data.length;
    onProgress?.({ files, bytes, path });
  }
  zip.end();
  await done;
  if (failure) throw failure;
  return new Blob(chunks as BlobPart[], { type: "application/zip" });
}

export function exportFileName(mode: ExportMode, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return mode === "full" ? `methyl-backup-${date}.zip` : `methyl-vault-${date}.zip`;
}
