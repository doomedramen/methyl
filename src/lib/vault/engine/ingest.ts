import type { TreeID } from "loro-crdt";
import { type DocIndex, type FileSnapshot, reconcileVault } from "@/lib/core/doc-index";
import { CONTENT_KEY, Document } from "@/lib/core/document";
import { sha256Text } from "@/lib/core/hash";
import { mergeExternalEdit } from "@/lib/core/merge";
import type { MaterializationCheckpoint } from "@/lib/core/types";
import type { VaultEngine } from "@/lib/vault/engine";
import {
  buildPathFromNode,
  isIgnoredExternalPath,
  isMarkdownPath,
} from "@/lib/vault/engine/helpers";
import type { IngestReport } from "@/lib/vault/engine/types";

/**
 * External changes (SPEC §24–§27): ingest edits, moves, copies, new files
 * and deletions from disk, behind the safety rails, and reconcile disk with
 * the tree.
 */

/**
 * Ingest external filesystem changes into the CRDT/tree (SPEC §5, §25,
 * §26): scans materialised `.md` files, reconciles them against the
 * sidecar doc index via `reconcileVault()`, and applies the result:
 *
 *   - known path, content changed        -> three-way merge into LoroText
 *   - moved (missing indexed path match) -> tree move/rename, id kept
 *   - copied (still-present path match)  -> new document, fresh id
 *   - genuinely new file                 -> new document
 *   - indexed path gone, unclaimed       -> deleteDocument
 *
 * Must run BEFORE any pass that treats disk as *output* (materializing
 * "stale" docs, deleting "orphan" files) — see reconcileMaterialization,
 * which calls this first. Otherwise an external edit would be silently
 * overwritten and a new external file would be deleted as an "orphan"
 * rather than adopted.
 *
 * One guard against a false positive: a file whose content matches an
 * already tree-tracked, loaded document that was never actually written
 * to disk at *this* path is NOT adopted as a second "new" document —
 * that's the ordinary materialize-lag case (a doc created this session,
 * or a rename/move interrupted by a crash before the old file was
 * cleaned up), not an external contribution. It's left for
 * reconcileMaterialization's expected-path pass, which re-derives
 * placement from the tree (the authority while the app is running) and
 * GCs the leftover.
 */
export async function ingestExternalChangesNow(engine: VaultEngine): Promise<IngestReport> {
  // Comparing disk with documents that aren't loaded yet would read as
  // edits and deletions that never happened.
  await engine.allDocumentsLoaded;
  const empty: IngestReport = {
    edited: [],
    moved: [],
    copied: [],
    created: [],
    deleted: [],
  };

  const trackedBefore = engine.tree.documentIds().length;
  // A copy: entries written while this pass applies its results must not
  // change the baseline it compares against.
  const prevIndex = { ...(await engine.loadDocIndex()) };
  let diskPaths = (await engine.docStore.listMaterializedPaths()).filter(
    (p) => isMarkdownPath(p) && !isIgnoredExternalPath(p),
  );

  // Safety rail #1: never treat "the disk scan came back empty" as "the
  // user deleted everything" — not even for a single-document vault. A
  // transient read glitch (an OPFS walk() race, a storage hiccup, a
  // listing call against a not-yet-ready handle) must not be
  // indistinguishable from a real deletion. This is the exact failure
  // mode that wiped a real vault: an empty scan combined with an
  // unconditional persistTree()/saveDocIndex() at the end permanently
  // overwrote a good tree snapshot with an empty one.
  //
  // Applies whenever we have something to lose (tracked docs and/or a
  // non-empty index) — verified by re-scanning once rather than trusting
  // a single read. A genuinely empty vault (both scans agree) still
  // proceeds normally, including the legitimate "deleted my one and only
  // note" case; only a scan that disagrees with itself is refused.
  const hasSomethingToLose = trackedBefore >= 1 || Object.keys(prevIndex).length > 0;
  if (diskPaths.length === 0 && hasSomethingToLose) {
    const recheck = (await engine.docStore.listMaterializedPaths()).filter(
      (p) => isMarkdownPath(p) && !isIgnoredExternalPath(p),
    );
    if (recheck.length > 0) {
      console.warn(
        `[VaultEngine] ingestExternalChanges: disk scan returned 0 markdown ` +
          `files but a re-scan found ${recheck.length} — treating the first ` +
          `scan as a transient read glitch and refusing to ingest engine pass.`,
      );
      await engine.diag("refuse-empty-scan", {
        counts: { trackedBefore, recheckFiles: recheck.length },
      });
      return empty;
    }
    diskPaths = recheck; // both scans agree: []
  }

  const files: FileSnapshot[] = [];
  for (const path of diskPaths) {
    const bytes = await engine.docStore.readMaterialized(path);
    if (bytes) files.push({ path, content: new TextDecoder().decode(bytes) });
  }

  const liveHashes = new Map<string, string>();
  for (const [id, doc] of engine.documents) {
    if (!engine.tree.findByDocumentId(id)) continue;
    liveHashes.set(await sha256Text(doc.getMarkdown()), id);
  }

  const result = await reconcileVault(prevIndex, files);
  const report: IngestReport = {
    edited: [],
    moved: [],
    copied: [],
    created: [],
    deleted: [],
  };
  const finalIndex: DocIndex = {};

  // Safety rail #2: refuse a mass deletion in one pass. A handful of
  // real external deletes is normal; more than half of everything we
  // know about disappearing at once (or all of it) is far more likely a
  // bad/partial disk scan than a deliberate bulk delete — log and skip
  // the deletions entirely (the rest of the ingest — edits/moves/new
  // files — still proceeds; nothing about those is destructive).
  const knownDocCount = Math.max(trackedBefore, Object.keys(prevIndex).length);
  const massDeletionThreshold = Math.max(1, Math.ceil(knownDocCount * 0.5));
  const deletionsRefused = knownDocCount > 0 && result.deletedPaths.length >= massDeletionThreshold
    && result.deletedPaths.length > 0
    && knownDocCount > 1; // a single-doc vault losing its one doc isn't "mass"
  if (deletionsRefused) {
    console.warn(
      `[VaultEngine] ingestExternalChanges: refusing to delete ` +
        `${result.deletedPaths.length}/${knownDocCount} tracked document(s) ` +
        `in one pass (over the mass-deletion threshold) — skipping all ` +
        `deletions engine run. Delete them individually via the app if engine ` +
        `is intentional.`,
    );
    await engine.diag("refuse-mass-deletion", {
      counts: { attempted: result.deletedPaths.length, known: knownDocCount },
    });
  }

  // Deletions: an indexed path disappeared and wasn't claimed by a move.
  if (!deletionsRefused) {
    for (const path of result.deletedPaths) {
      const entry = prevIndex[path];
      if (!entry) continue;
      const node = engine.tree.findByDocumentId(entry.id);
      if (node) {
        engine.tree.delete(node.treeId);
        engine.documents.delete(entry.id);
        engine.materializedPaths.delete(entry.id);
        report.deleted.push(entry.id);
        await engine.diag("ingest-delete", { detail: `${entry.id} ${path}` });
      }
    }
  }

  engine.indexTouchesThisPass = new Set();
  // The index file is written once, with the final index, at the end.
  engine.deferDocIndexWrites = true;
  try {
  for (const r of result.resolved) {
    const entryHash = result.index[r.path]!.contentHash;

    if (r.kind === "new" && liveHashes.has(entryHash)) {
      // Materialize-lag false positive — see doc comment above.
      continue;
    }

    const segments = r.path.split("/");
    const fileName = segments.pop()!;

    if (r.kind === "known") {
      const prevEntry = prevIndex[r.path];
      const changed = !prevEntry || prevEntry.contentHash !== entryHash;
      // Even when the content itself is unchanged, a lingering legacy
      // `adhd:id` comment (r.rewrite) still needs writing back clean —
      // otherwise a migrated-but-untouched file never gets its one-time
      // cleanup materialised to disk.
      if (changed || r.rewrite) {
        const doc = engine.documents.get(r.id);
        if (doc) {
          // This pass consumes the file's current disk content, so record
          // it as seen: the write-back below must not be deferred as an
          // un-ingested external edit.
          await engine.touchIndexEntry(r.path, r.id, r.cleanContent);
          const state = await engine.docStore.readState(r.id);
          const currentContent = doc.getText(CONTENT_KEY).toString();
          if (!r.rewrite && r.cleanContent === currentContent) {
            // The file already says what the CRDT says: the app wrote it
            // and its index update never landed (e.g. the tab closed
            // first). Nothing to merge — merging would only churn history.
            await engine.touchIndexEntry(r.path, r.id, currentContent, doc.doc.oplogFrontiers());
            finalIndex[r.path] = result.index[r.path]!;
            continue;
          }

          // Safety rail: never let an "external edit" that shrinks or
          // empties content win over CRDT changes newer than the index
          // entry. `prevEntry.contentHash` is what the CRDT looked like
          // the last time this path was actually written/indexed by the
          // app; if the CRDT's *current* content no longer matches that
          // hash, there's a local edit the index doesn't know about yet
          // (un-materialized). Combined with the incoming disk content
          // being shorter/emptier than what's currently in the CRDT,
          // this "edit" is far more likely a race (a stale/partial write
          // losing to — or arriving before — the real content, or a scan
          // catching a file mid-write) than a deliberate external
          // shrink. Keep the CRDT's content; log and skip the merge.
          const currentHash = await sha256Text(currentContent);
          const hasUnindexedChanges = !prevEntry || prevEntry.contentHash !== currentHash;
          // "Shrink" is measured against what was last written to disk (the
          // merge base), not against the CRDT: the CRDT may hold newer
          // changes (a client's edit) that make it longer than a disk edit
          // which itself only *added* text. The three-way merge keeps the
          // CRDT's own changes either way; the rail only guards against a
          // file that lost content since the app last wrote it.
          const baseLength = prevEntry?.size ?? currentContent.length;
          const wouldShrinkOrEmpty =
            currentContent.length > 0 && r.cleanContent.length < baseLength;

          if (changed && hasUnindexedChanges && wouldShrinkOrEmpty) {
            console.warn(
              `[VaultEngine] ingestExternalChanges: refusing to shrink/empty ` +
                `document ${r.id} at "${r.path}" (disk has ${r.cleanContent.length} ` +
                `chars, CRDT has ${currentContent.length} un-materialized-newer chars) ` +
                `— keeping the CRDT's content and re-materializing it instead.`,
            );
            // Disk is now wrong relative to the CRDT we're keeping —
            // write the CRDT's real content back rather than leaving a
            // stale/conflicting file sitting there.
            await engine.persistDocumentIncremental(r.id);
          } else {
            const checkpoint: MaterializationCheckpoint = {
              documentId: r.id,
              // The version last written to this path is the true merge
              // base; the persisted state's frontiers can be newer than
              // what's on disk (it tracks compaction, not writes).
              frontiers: prevEntry?.frontiers ?? state?.frontiers ?? doc.frontiers(),
              sha256: state?.sha256 ?? "",
            };
            mergeExternalEdit(doc.doc, checkpoint, r.cleanContent);
            engine.materializedPaths.set(r.id, r.path);
            await engine.persistDocumentIncremental(r.id);
            report.edited.push(r.id);
          }
        }
      }
    } else if (r.kind === "move") {
      const node = engine.tree.findByDocumentId(r.id);
      if (node) {
        const parent = engine.ensureFolderPath(segments);
        engine.tree.move(node.treeId, parent);
        if (node.name !== fileName) engine.tree.rename(node.treeId, fileName);
        engine.materializedPaths.set(r.id, r.path);
        if (r.rewrite) {
          const doc = engine.documents.get(r.id);
          if (doc && doc.getMarkdown() !== r.cleanContent) {
            doc.setText(r.cleanContent);
            await engine.persistDocumentIncremental(r.id);
          }
        }
        report.moved.push(r.id);
      }
    } else if (!engine.documents.has(r.id)) {
      // "copy" or "new": a document we don't yet track under this id.
      const parent = engine.ensureFolderPath(segments);
      const doc = Document.fromMarkdown(r.id, r.cleanContent);
      engine.tree.addMarkdownDocument(parent, fileName, r.id);
      engine.setDocument(r.id, doc);
      engine.materializedPaths.set(r.id, r.path);
      await engine.persistDocumentIncremental(r.id);
      (r.kind === "copy" ? report.copied : report.created).push(r.id);
    }

    finalIndex[r.path] = result.index[r.path]!;
  }

  } finally {
    engine.deferDocIndexWrites = false;
  }

  // Paths this pass wrote back (merged content, re-materialised CRDT)
  // already have a current entry, with the version written; the scan's
  // entry describes the file as it was *before* those writes.
  const touched = engine.indexTouchesThisPass;
  engine.indexTouchesThisPass = null;
  if (touched && touched.size > 0) {
    const current = await engine.loadDocIndex();
    for (const path of touched) {
      if (path in finalIndex && current[path]?.id === finalIndex[path]!.id) finalIndex[path] = current[path]!;
    }
  }

  await engine.persistTree();
  await engine.saveDocIndex(finalIndex);
  if (
    report.edited.length > 0 ||
    report.moved.length > 0 ||
    report.copied.length > 0 ||
    report.created.length > 0 ||
    report.deleted.length > 0
  ) {
    await engine.refreshIndexes();
  }
  return report;
}

/** Find or create the folder chain for `segments`, returning its final TreeID. */
export function ensureFolderPath(
  engine: VaultEngine,
  segments: string[],
  created?: string[],
): TreeID | undefined {
  let parent: TreeID | undefined;
  let path = "";
  for (const seg of segments) {
    if (!seg) continue;
    path = path ? `${path}/${seg}` : seg;
    const siblings = parent ? engine.tree.children(parent): engine.tree.roots();
    const existing = siblings.find(
      (n) => n.kind === "directory" && n.name.toLowerCase() === seg.toLowerCase(),
    );
    if (existing) {
      parent = existing.treeId;
    } else {
      parent = engine.tree.addDirectory(parent, seg);
      created?.push(path);
    }
  }
  return parent;
}

/**
 * Resolve any post-merge same-name sibling collisions (VaultTree.
 * resolveNameCollisions()) and re-materialise every markdown document
 * that got renamed, so its on-disk file moves to the new deterministic
 * path (and the old, now-wrong path is removed) rather than leaving a
 * stale file behind under the pre-collision name. Call this after
 * anything that can merge in a foreign tree state — a sync round, or an
 * imported tree update — and before relying on buildPathFromNode() for
 * any of the affected documents.
 */
export async function resolveTreeNameCollisions(engine: VaultEngine): Promise<string[]> {
  const renamedTreeIds = engine.tree.resolveNameCollisions();
  if (renamedTreeIds.length === 0) return [];
  for (const treeId of renamedTreeIds) {
    const node = engine.tree.getNode(treeId);
    if (!node || node.kind !== "markdown" || !node.documentId) continue;
    if (!engine.documents.has(node.documentId)) continue; // content not loaded here yet — a later sync round will materialize it at its (now-correct) path
    await engine.materializeToTreePath(node.documentId);
  }
  return renamedTreeIds.map((id) => String(id));
}

/**
 * Boot-time (and on-demand) reconciliation so the on-disk vault tree
 * always mirrors the CRDT tree + content:
 *   - ingest external changes first (see ingestExternalChanges) so an
 *     external edit/move/copy/new-file/delete is absorbed rather than
 *     clobbered by the passes below
 *   - re-materialise any tracked doc whose file is missing or stale
 *   - delete any stale materialised `.md` that no longer corresponds to a
 *     tree node (stale path left behind by a rename/move that happened
 *     before this session, e.g. across a crash) — unknown ordinary files
 *     are adopted as binary nodes or preserved, and `.methyl` is never touched
 */
export async function reconcileMaterialization(engine: VaultEngine): Promise<{
  ingested: IngestReport;
  materialized: string[];
  removed: string[];
}> {
  await engine.allDocumentsLoaded;
  await engine.resolveTreeNameCollisions();
  const folders = await engine.ingestExternalFolders();
  const ingested = await engine.ingestExternalChanges();
  if (folders.created.length > 0) ingested.foldersCreated = folders.created;
  const assets = await engine.ingestExternalAssets();
  if (assets.created.length > 0) ingested.assetsCreated = assets.created;
  if (assets.updated.length > 0) ingested.assetsUpdated = assets.updated;

  const materialized: string[] = [];
  // The ingest above has just compared every file with the index, so the
  // index now describes the disk: a document is stale when its content
  // differs from its index entry. No need to read and hash every file a
  // second time.
  const index = await engine.loadDocIndex();
  const onDisk = new Set(await engine.docStore.listMaterializedPaths());
  for (const node of engine.tree.allNodes()) {
    const path = buildPathFromNode(engine.tree, node);
    if (!path) continue;
    if (node.kind === "binary") {
      engine.materializedAssetPaths.set(String(node.treeId), path);
      continue;
    }
    if (node.kind !== "markdown" || !node.documentId) continue;
    const doc = engine.documents.get(node.documentId);
    if (!doc) continue;
    const entry = index[path];
    const stale =
      !entry ||
      entry.id !== node.documentId ||
      !onDisk.has(path) ||
      entry.contentHash !== (await sha256Text(doc.getText(CONTENT_KEY).toString()));
    if (stale) {
      const cp = await engine.materializeDocument(node.documentId, path);
      if (cp) materialized.push(path);
    } else {
      engine.materializedPaths.set(node.documentId, path);
    }
  }

  // What the tree expects on disk, computed *now*: reconcile can run in
  // the background while the app is in use, and a note created meanwhile
  // must not be swept away as an orphan.
  const expected = new Set<string>();
  for (const node of engine.tree.allNodes()) {
    if (node.kind !== "binary" && !(node.kind === "markdown" && node.documentId)) continue;
    const path = buildPathFromNode(engine.tree, node);
    if (path) expected.add(path);
  }

  const removed: string[] = [];
  for (const path of await engine.docStore.listMaterializedPaths()) {
    if (path.endsWith(".tmp")) continue;
    if (!expected.has(path)) {
      // Markdown paths are safe to garbage-collect only after the
      // document ingest pass has established that they are stale. Unknown
      // ordinary files are user data (and may be attachments from another
      // tool), so preserve them until the attachment reconciler adopts or
      // explicitly removes them.
      if (isMarkdownPath(path)) {
        await engine.materializedRemove(path);
        removed.push(path);
      } else {
        await engine.diag("preserve-unknown-materialized-file", { detail: path });
      }
    }
  }
  if (removed.length > 0) {
    await engine.diag("orphan-sweep", {
      counts: { removed: removed.length },
      detail: removed.slice(0, 10).join(","),
    });
  }
  return { ingested, materialized, removed };
}
