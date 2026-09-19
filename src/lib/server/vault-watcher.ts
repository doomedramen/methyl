import chokidar, { type FSWatcher } from "chokidar";
import type { TreeID } from "loro-crdt";
import type { VaultEngine } from "@/lib/vault/engine";

/**
 * Watches a Node filesystem vault for external Markdown and attachment changes (edits made
 * outside ADHD — another editor, `git checkout`, a sync client writing
 * directly to disk, etc.) and feeds them through
 * `VaultEngine.ingestExternalChanges()` (SPEC §5, §25, §26).
 *
 * - Ignores `.adhd/**` (CRDT storage + the sidecar doc index) and `*.tmp`
 *   (the atomic-write staging file every materialize goes through) so the
 *   app's own bookkeeping never triggers a re-ingest of itself.
 * - Ignores the app's *own* `.md` writes too, but via a different
 *   mechanism: every `materializeDocument`/`materializeToTreePath`/
 *   `repairDocument` call updates the sidecar index (`.adhd/index.json`)
 *   with the hash of what it just wrote (see VaultEngine.touchIndexEntry),
 *   so by the time this watcher's debounced ingest runs,
 *   `ingestExternalChanges()` sees the disk content already matches the
 *   index and treats it as a no-op — no separate "was this us?" tracking
 *   needed here.
 * - Debounces bursts of fs events (a save is often unlink+create, or
 *   several writes in quick succession) into one ingest pass.
 * - Reports resulting CRDT changes via `onRoomUpdate(roomId, snapshotBytes)`
 *   so a caller can push them into the existing sync broadcast path
 *   (`doc:<id>` for edited/copied/created documents, `vault:<vaultId>` for
 *   anything that changed the tree: move/copy/create/delete).
 */
export interface VaultWatcherOptions {
  vaultPath: string;
  engine: VaultEngine;
  /** Debounce window after the last fs event before ingesting (ms). */
  debounceMs?: number;
  /** `snapshot` is a full Loro snapshot export of the room, not an incremental update. */
  onRoomUpdate?: (roomId: string, snapshot: Uint8Array) => void;
  /** Publish bytes for a newly adopted or externally changed attachment. */
  onAssetUpdate?: (assetId: string, bytes: Uint8Array) => void | Promise<void>;
  onError?: (err: unknown) => void;
  /** Called after each ingest pass completes (useful for tests). */
  onIngested?: (report: Awaited<ReturnType<VaultEngine["ingestExternalChanges"]>>) => void;
}

export function watchVaultForExternalChanges(
  options: VaultWatcherOptions,
): FSWatcher {
  const { vaultPath, engine, debounceMs = 300, onRoomUpdate, onAssetUpdate, onError, onIngested } =
    options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pendingWhileRunning = false;

  const runIngest = async () => {
    if (running) {
      pendingWhileRunning = true;
      return;
    }
      running = true;
    try {
      const report = await engine.ingestExternalChanges();
      const assets = await engine.ingestExternalAssets();
      if (assets.created.length > 0) report.assetsCreated = assets.created;
      if (assets.updated.length > 0) report.assetsUpdated = assets.updated;
      onIngested?.(report);

      if (onRoomUpdate) {
        const docIds = new Set([
          ...report.edited,
          ...report.copied,
          ...report.created,
        ]);
        for (const id of docIds) {
          const doc = engine.getDocument(id);
          if (doc) onRoomUpdate(`doc:${id}`, doc.snapshot());
        }
        const treeChanged =
          report.moved.length > 0 ||
          report.copied.length > 0 ||
          report.created.length > 0 ||
          report.deleted.length > 0 ||
          (report.assetsCreated?.length ?? 0) > 0 ||
          (report.assetsUpdated?.length ?? 0) > 0;
        if (treeChanged) {
          onRoomUpdate(`vault:${engine.vaultId}`, engine.tree.snapshot());
        }
      }
      if (onAssetUpdate) {
        const assetIds = new Set([
          ...(report.assetsCreated ?? []),
          ...(report.assetsUpdated ?? []),
        ]);
        for (const assetId of assetIds) {
          const bytes = await engine.readAttachment(assetId as TreeID);
          if (bytes) await onAssetUpdate(assetId, bytes);
        }
      }
    } catch (err) {
      onError?.(err);
    } finally {
      running = false;
      if (pendingWhileRunning) {
        pendingWhileRunning = false;
        void runIngest();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void runIngest(), debounceMs);
  };

  const watcher = chokidar.watch(vaultPath, {
    // Two-arg form: `stats` lets us tell files from directories, so we
    // don't accidentally stop chokidar from descending into subfolders.
    ignored: (path: string, stats?: { isFile: () => boolean }) => {
      if (path.split(/[\\/]/).includes(".adhd")) return true;
      if (path.endsWith(".tmp")) return true;
      const normalized = path.replaceAll("\\", "/");
      if (stats?.isFile() && !path.endsWith(".md") && !normalized.includes("/Attachments/")) return true;
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
  });

  watcher.on("add", schedule).on("change", schedule).on("unlink", schedule);

  return watcher;
}
