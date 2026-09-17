import { extractIdFromMarkdown, stripIdComment } from "@/lib/core/doc-id";
import { sha256Text } from "@/lib/core/hash";

/**
 * Sidecar document index (§5 / §26 of SPEC.md).
 *
 * Identity lives outside the Markdown content:
 *   - Inside the app, the vault-tree CRDT (tree node → documentId) is
 *     authoritative (see VaultTree in @/lib/vault/tree).
 *   - For reconciling *external* filesystem changes (disk watcher, server
 *     rescans, crash recovery) we keep a hidden sidecar index mapping
 *     relative path → { id, contentHash, mtime }. This is the on-disk
 *     analogue of the tree, persisted at `.adhd/index.json` alongside the
 *     `.adhd/crdt/` layout (see PersistedDocStore in @/lib/vault/store).
 *
 * `.md` files themselves stay 100% clean: no id comment, ever — in the
 * editor's LoroText or on disk. Legacy files that still carry the old
 * `<!-- adhd:id=... -->` comment are migrated on read: the id is recovered,
 * the comment is stripped, the file is rewritten clean, and the recovered
 * id is recorded in the index.
 */
export interface DocIndexEntry {
  id: string;
  contentHash: string;
  size: number;
  mtime: number;
}

/** relative path -> entry */
export type DocIndex = Record<string, DocIndexEntry>;

export interface FileSnapshot {
  path: string;
  /** Raw file content as read from disk (may still carry a legacy comment). */
  content: string;
  mtime?: number;
}

export type ReconcileKind = "known" | "move" | "copy" | "new";

export interface ResolvedFile {
  path: string;
  kind: ReconcileKind;
  id: string;
  /** Content with any legacy id comment stripped — what should be stored. */
  cleanContent: string;
  /** True if the on-disk file must be rewritten (legacy comment present). */
  rewrite: boolean;
  /** For "move"/"copy", the previously indexed path the content matched. */
  sourcePath?: string;
}

export interface ReconcileResult {
  index: DocIndex;
  resolved: ResolvedFile[];
  /** Indexed paths that disappeared and were not claimed by a move. */
  deletedPaths: string[];
}

/**
 * Reconcile a full snapshot of vault files against the previous sidecar
 * index. Pure/stateless — callers persist `result.index` and apply
 * `result.resolved[].rewrite` (tmp→rename) and `deletedPaths` themselves.
 *
 * Rules (SPEC §5, §26):
 *   - path known (present in the previous index)      -> same id, content
 *     edits do not change identity.
 *   - unknown path whose content hash matches a path   -> move: keep id.
 *     that is now MISSING from the current snapshot
 *   - unknown path whose content hash matches a path   -> copy: fresh id.
 *     that is STILL PRESENT in the current snapshot
 *   - unknown path, no hash match, legacy id comment    -> migrated: use the
 *     present and not already claimed                   legacy id, strip it.
 *   - unknown path, no hash match, no legacy id         -> new document.
 *   - indexed path missing from the snapshot and not     -> deletion.
 *     claimed by a move
 */
export async function reconcileVault(
  prevIndex: DocIndex,
  files: FileSnapshot[],
  genId: () => string = () => crypto.randomUUID(),
): Promise<ReconcileResult> {
  const currentPaths = new Set(files.map((f) => f.path));

  const missing = new Map<string, DocIndexEntry>();
  for (const [path, entry] of Object.entries(prevIndex)) {
    if (!currentPaths.has(path)) missing.set(path, entry);
  }
  const consumedMissing = new Set<string>();
  const claimedLegacyIds = new Set(Object.values(prevIndex).map((e) => e.id));

  const newIndex: DocIndex = {};
  const resolved: ResolvedFile[] = [];

  for (const file of files) {
    const legacyId = extractIdFromMarkdown(file.content);
    const cleanContent = legacyId ? stripIdComment(file.content) : file.content;
    const hash = await sha256Text(cleanContent);

    const prevEntry = prevIndex[file.path];
    let kind: ReconcileKind;
    let id: string;
    let sourcePath: string | undefined;

    if (prevEntry) {
      kind = "known";
      id = prevEntry.id;
    } else {
      // Look for a move: a missing indexed path with the same content hash.
      let moveSource: string | undefined;
      for (const [mp, me] of missing) {
        if (consumedMissing.has(mp)) continue;
        if (me.contentHash === hash) {
          moveSource = mp;
          break;
        }
      }
      if (moveSource) {
        kind = "move";
        id = missing.get(moveSource)!.id;
        sourcePath = moveSource;
        consumedMissing.add(moveSource);
      } else {
        // Look for a copy: a still-present indexed path with the same hash.
        let copySource: string | undefined;
        for (const [op, oe] of Object.entries(prevIndex)) {
          if (op === file.path) continue;
          if (currentPaths.has(op) && oe.contentHash === hash) {
            copySource = op;
            break;
          }
        }
        if (copySource) {
          kind = "copy";
          id = genId();
          sourcePath = copySource;
        } else if (legacyId && !claimedLegacyIds.has(legacyId)) {
          // Migration: recover identity from the legacy comment.
          kind = "new";
          id = legacyId;
          claimedLegacyIds.add(legacyId);
        } else {
          kind = "new";
          id = genId();
        }
      }
    }

    const rewrite = legacyId !== null;
    resolved.push({ path: file.path, kind, id, cleanContent, rewrite, sourcePath });
    newIndex[file.path] = {
      id,
      contentHash: hash,
      size: cleanContent.length,
      mtime: file.mtime ?? Date.now(),
    };
  }

  const deletedPaths = Array.from(missing.keys()).filter(
    (p) => !consumedMissing.has(p),
  );

  return { index: newIndex, resolved, deletedPaths };
}
