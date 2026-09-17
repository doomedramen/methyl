import { OpfsVaultFS } from "@/lib/vault/opfs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import {
  acquireVaultWriterLock,
  onVaultWriterStolen,
  waitForVaultWriterPromotion,
} from "@/lib/vault/web-locks";
import { loadSyncConfig } from "@/lib/browser/sync-config";
import { writeSeedMarker } from "@/lib/browser/seed-marker";

/**
 * Whether this tab is the vault's writer, or read-only because another tab
 * already holds the writer lock (§12).
 *
 * A read-only tab can:
 *   - `takeOver()`: explicitly steal the writer lock now ("Use here").
 *   - once `promotable` is true (the previous writer tab released — closed
 *     or navigated away — and this tab's background queued request for
 *     the lock was granted), `reload()` to become the writer.
 *
 * Both actions reload the page rather than hot-swapping this tab's engine
 * in place: the simplest correct way to move a whole read-only session
 * (in-memory engine, React tree, any open editor) into writer mode is to
 * re-run getVault() from scratch, which then acquires the lock normally.
 */
export type VaultAccessStatus =
  | { kind: "writer" }
  | {
      kind: "read-only";
      promotable: boolean;
      takeOver: () => void;
      reload: () => void;
    };

let accessStatus: VaultAccessStatus = { kind: "writer" };
const accessListeners = new Set<(status: VaultAccessStatus) => void>();

export function getVaultAccessStatus(): VaultAccessStatus {
  return accessStatus;
}

export function onVaultAccessStatusChange(
  listener: (status: VaultAccessStatus) => void,
): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

function setAccessStatus(next: VaultAccessStatus): void {
  accessStatus = next;
  for (const listener of accessListeners) listener(next);
}

/**
 * Whether a brand-new vault should seed the onboarding welcome note (see
 * getVault() below for why not when sync is already configured). Pulled
 * out as its own pure function so the decision is unit-testable without
 * OPFS/Web Locks — getVault() itself needs a real browser to exercise.
 */
export function shouldSeedWelcomeNote(): boolean {
  return loadSyncConfig() === null;
}

let singleton: VaultEngine | null = null;
let booting: Promise<VaultEngine> | null = null;

/**
 * Boot the vault in the browser (single writer per origin).
 *
 * The lock is acquired for the whole session so the offline kernel owns the
 * store; other tabs stay read-only (§12).
 */
export async function getVault(): Promise<VaultEngine> {
  if (singleton) return singleton;
  if (booting) return booting;

  booting = (async () => {
    const fs = new OpfsVaultFS();
    const treeStore = new OpfsVaultTreeStore(fs);
    const docStore = new OpfsDocStore(fs);

    const lock = await acquireVaultWriterLock("local");
    if (!lock.active) {
      // Second tab: open read-only until a takeover is requested or this
      // tab is naturally promoted once the writer tab releases.
      const { engine } = await VaultEngine.open(treeStore, docStore, "local");
      singleton = engine;

      const takeOver = () => {
        void acquireVaultWriterLock("local", { steal: true }).then((stolen) => {
          if (stolen.active) {
            stolen.release();
            window.location.reload();
          }
        });
      };
      const reload = () => window.location.reload();
      setAccessStatus({ kind: "read-only", promotable: false, takeOver, reload });

      // Queue in the background for the writer lock to become free
      // naturally (the current writer tab closes/navigates away) — no
      // polling: the browser grants this the moment it's free.
      const promotionAbort = new AbortController();
      waitForVaultWriterPromotion("local", promotionAbort.signal)
        .then((promoted) => {
          if (!promoted.active) return;
          // Don't keep holding it mid-session (see the class doc above) —
          // release it immediately and just flag that a reload would now
          // succeed. Another waiting tab could still grab it first; if so,
          // reload() below just goes read-only again and re-queues.
          promoted.release();
          setAccessStatus({ kind: "read-only", promotable: true, takeOver, reload });
        })
        .catch(() => {});
      if (typeof window !== "undefined") {
        window.addEventListener("pagehide", () => promotionAbort.abort(), { once: true });
      }

      return engine;
    }
    setAccessStatus({ kind: "writer" });

    // First boot: does a vault exist already?
    const treeSnap = await treeStore.loadSnapshot();
    const hasVault = treeSnap !== null || (await treeStore.loadUpdates()).length > 0;

    let engine: VaultEngine;
    if (hasVault) {
      const opened = await VaultEngine.open(treeStore, docStore, "local");
      engine = opened.engine;
      // Reconcile the on-disk .md tree against the CRDT tree+content: this
      // catches the legacy-id-comment migration (content changed, so the
      // file is now stale), any file that was missing/stale from a crash
      // mid-write, and any orphaned file left behind by a rename/move that
      // didn't finish persisting.
      await engine.reconcileMaterialization();
    } else if (!shouldSeedWelcomeNote()) {
      // A sync server is already configured on this device: this vault is
      // about to receive whatever the peer(s) it syncs with already have,
      // so seeding a local welcome note here would race a *different*
      // fresh device doing the same thing — each generates its own random
      // document id (VaultEngine.createDocument), so the merge produces
      // two distinct "Welcome" notes in the same folder instead of one.
      // (Giving the welcome note a fixed, well-known id instead was
      // considered — it would make the *document* converge, but each
      // device still independently creates its own *tree node* pointing
      // at it, since neither knows about the other before the first sync;
      // VaultTree has no notion of "these two nodes are the same node", so
      // the sidebar would still show two rows for one merged note. Skipping
      // the seed is simpler and avoids that case entirely; the tradeoff is
      // an empty vault, with no onboarding note, until the first sync
      // round completes.)
      engine = await VaultEngine.create(treeStore, docStore, "local");
    } else {
      engine = await createFreshVault(fs, treeStore, docStore);
    }
    engine.releaseWriterLock = () => lock.release();
    singleton = engine;
    watchVisibilityForExternalChanges(engine);
    // Release promptly on tab close/navigation so a waiting tab (see
    // waitForVaultWriterPromotion above) gets promoted right away instead
    // of only after the browser force-releases on context teardown.
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => lock.release(), { once: true });
    }
    // Another tab explicitly took over ("Use here" / steal) — the Web
    // Locks API itself doesn't tell this tab it lost the lock (see
    // onVaultWriterStolen's doc comment), so react to the broadcast: this
    // tab's in-memory state is now stale (no longer the writer), and the
    // simplest correct recovery is the same one used elsewhere in this
    // module — reload, and getVault() will cleanly re-open read-only.
    onVaultWriterStolen("local", () => {
      if (typeof window !== "undefined") window.location.reload();
    });
    return engine;
  })();

  try {
    return await booting;
  } finally {
    booting = null;
  }
}

/**
 * OPFS has no external writers other than another tab of this same app, so
 * there's no watcher to wire up (unlike the Node server — see
 * sync-server.ts). The one useful moment to re-check is when this tab comes
 * back into the foreground, in case a *different* tab wrote to the vault
 * while this one was backgrounded (e.g. it took over the writer lock and
 * has since released it back). Deliberately light: only the cheap ingest
 * pass, not the full stale/orphan sweep, and only for the tab that
 * currently holds the writer lock — guarded against overlap with itself.
 */
let ingestingOnVisibility = false;
function watchVisibilityForExternalChanges(engine: VaultEngine): void {
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!engine.releaseWriterLock) return; // read-only tab: nothing to ingest into
    if (ingestingOnVisibility) return;
    ingestingOnVisibility = true;
    engine
      .ingestExternalChanges()
      .catch((err) => console.error("[vault] visibility ingest failed", err))
      .finally(() => {
        ingestingOnVisibility = false;
      });
  });
}

/**
 * Seed a demo note so the first run is not a blank void. Called only when no
 * vault exists yet.
 */
async function createFreshVault(
  fs: OpfsVaultFS,
  treeStore: OpfsVaultTreeStore,
  docStore: OpfsDocStore,
): Promise<VaultEngine> {
  const engine = await VaultEngine.create(treeStore, docStore, "local");
  const welcome = `---
title: Welcome
tags: [getting-started]
---

# Welcome

This is your Methyl vault. Everything lives in your browser's file system
(OPFS) and syncs over the Loro CRDT when a server is reachable.

- Write notes in Markdown
- Link with [[Welcome|wikilinks]] to build a graph
- Full offline support via the service worker
`;

  const doc = engine.createDocument(undefined, "welcome.md", welcome);
  await engine.persistTree();
  await engine.materializeDocuments([doc.id]);
  await engine.persistDocumentIncremental(doc.id);
  await writeSeedMarker(fs, doc.id, welcome);
  return engine;
}