import type { TreeID } from "loro-crdt";
import { sanitizeName } from "@/lib/core/paths";
import type { VaultEngine } from "@/lib/vault/engine";

/** A lazily-read file from an Obsidian vault. */
export interface ObsidianImportEntry {
  path: string;
  read: () => Promise<Uint8Array>;
  size?: number;
}

export interface ObsidianImportSkippedFile {
  path: string;
  reason: string;
}

export interface ObsidianImportFailedFile {
  path: string;
  reason: string;
}

export interface ObsidianImportReport {
  notes: number;
  files: number;
  imported: string[];
  skipped: ObsidianImportSkippedFile[];
  failed: ObsidianImportFailedFile[];
}

export interface ObsidianImportProgress {
  current: number;
  total: number;
  path: string;
  kind: "note" | "file";
}

export type ObsidianImportProgressListener = (
  progress: ObsidianImportProgress,
) => void | Promise<void>;

export interface PreparedObsidianImport {
  entries: ObsidianImportEntry[];
  skipped: ObsidianImportSkippedFile[];
}

const IGNORED_DIRECTORIES = new Map<string, string>([
  [".adhd", "Methyl metadata"],
  [".git", "Git metadata"],
  [".obsidian", "Obsidian metadata"],
  [".trash", "Obsidian trash"],
  ["node_modules", "dependency folder"],
]);

const IGNORED_FILES = new Map<string, string>([
  [".ds_store", "system file"],
  ["thumbs.db", "system file"],
]);

/**
 * Normalize and validate paths before they reach VaultTree. Obsidian stores
 * user content in ordinary folders, but its metadata and trash are not part
 * of a portable note import.
 */
export function prepareObsidianImport(
  entries: Iterable<ObsidianImportEntry>,
): PreparedObsidianImport {
  const prepared: ObsidianImportEntry[] = [];
  const skipped: ObsidianImportSkippedFile[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const rawPath = entry.path;
    const parts = rawPath
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean);

    if (parts.length === 0) {
      skipped.push({ path: rawPath, reason: "empty path" });
      continue;
    }

    const safeParts: string[] = [];
    let skipReason: string | undefined;
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") {
        skipReason = "path escapes vault root";
        break;
      }
      const ignoredDirectory = IGNORED_DIRECTORIES.get(part.toLowerCase());
      if (ignoredDirectory) {
        skipReason = ignoredDirectory;
        break;
      }
      const safe = sanitizeName(part);
      if (!safe) {
        skipReason = "unsupported file name";
        break;
      }
      safeParts.push(safe);
    }

    if (skipReason) {
      skipped.push({ path: rawPath, reason: skipReason });
      continue;
    }

    const fileName = safeParts.at(-1);
    if (!fileName) {
      skipped.push({ path: rawPath, reason: "empty file name" });
      continue;
    }
    const ignoredFile = IGNORED_FILES.get(fileName.toLowerCase());
    if (ignoredFile) {
      skipped.push({ path: rawPath, reason: ignoredFile });
      continue;
    }

    // VaultTree uses `.md` as its canonical Markdown suffix. Obsidian is
    // normally lowercase, but accepting `NOTE.MD` avoids an avoidable import
    // failure while retaining the original stem.
    if (fileName.toLowerCase().endsWith(".md") && !fileName.endsWith(".md")) {
      safeParts[safeParts.length - 1] = `${fileName.slice(0, -3)}.md`;
    }

    const normalizedPath = safeParts.join("/");
    if (seen.has(normalizedPath.toLowerCase())) {
      skipped.push({ path: rawPath, reason: "duplicate path" });
      continue;
    }
    seen.add(normalizedPath.toLowerCase());
    prepared.push({ ...entry, path: normalizedPath });
  }

  return { entries: prepared, skipped };
}

/** Return whether an imported file becomes a Markdown document. */
export function isObsidianMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function folderKey(path: string): string {
  return path.toLowerCase();
}

function ensureFolderPath(
  engine: VaultEngine,
  segments: string[],
  cache: Map<string, TreeID>,
): TreeID | undefined {
  let parent: TreeID | undefined;
  let path = "";

  for (const segment of segments) {
    path = `${path}/${segment}`;
    const key = folderKey(path);
    const cached = cache.get(key);
    if (cached) {
      parent = cached;
      continue;
    }

    const siblings = parent ? engine.tree.children(parent) : engine.tree.roots();
    const existing = siblings.find(
      (node) => node.kind === "directory" && node.name.toLowerCase() === segment.toLowerCase(),
    );
    parent = existing?.treeId ?? engine.createFolder(parent, segment);
    cache.set(key, parent);
  }

  return parent;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Import an Obsidian vault into an existing Methyl vault.
 *
 * Notes and binary files keep their relative source folders. Existing sibling
 * names are handled by VaultTree's normal numbered suffixes. Files are read
 * one at a time so a large attachment does not make the whole vault resident
 * in memory at once.
 */
export async function importObsidianVault(
  engine: VaultEngine,
  sourceEntries: Iterable<ObsidianImportEntry>,
  onProgress?: ObsidianImportProgressListener,
): Promise<ObsidianImportReport> {
  const prepared = prepareObsidianImport(sourceEntries);
  const report: ObsidianImportReport = {
    notes: 0,
    files: 0,
    imported: [],
    skipped: [...prepared.skipped],
    failed: [],
  };
  const folders = new Map<string, TreeID>();

  for (let index = 0; index < prepared.entries.length; index += 1) {
    const entry = prepared.entries[index]!;
    const pathParts = entry.path.split("/");
    const fileName = pathParts.pop()!;
    const parent = ensureFolderPath(engine, pathParts, folders);
    const kind = isObsidianMarkdownPath(entry.path) ? "note" : "file";

    try {
      const bytes = await entry.read();
      if (kind === "note") {
        const markdown = new TextDecoder().decode(bytes);
        const doc = engine.createDocument(parent, fileName, markdown);
        await engine.persistDocumentIncremental(doc.id);
        report.notes += 1;
      } else {
        await engine.createAttachment(fileName, bytes, parent);
        report.files += 1;
      }
      report.imported.push(entry.path);
    } catch (error) {
      report.failed.push({ path: entry.path, reason: errorMessage(error) });
    }

    await onProgress?.({
      current: index + 1,
      total: prepared.entries.length,
      path: entry.path,
      kind,
    });
  }

  // Folder creation and note tree nodes are CRDT edits. Binary creation also
  // persists incrementally, but one final compact snapshot makes completion
  // durable even when an import contains only folders and notes.
  await engine.persistTree();
  return report;
}

export function importSummary(report: ObsidianImportReport): string {
  const items = report.notes + report.files;
  if (items === 0) return "No files imported";
  const notes = `${report.notes} ${report.notes === 1 ? "note" : "notes"}`;
  const files = `${report.files} ${report.files === 1 ? "file" : "files"}`;
  return `${notes} and ${files} imported`;
}
