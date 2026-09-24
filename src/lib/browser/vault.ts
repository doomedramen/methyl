import { migrateLegacyMetaDir } from "@/lib/vault/meta-migration";
import { markBoot } from "@/lib/core/boot-marks";
import { OpfsVaultFS, vaultRootParts } from "@/lib/vault/opfs";
import { migrateLegacyVaultRoot, rememberVault, resolveVault, type VaultInfo } from "@/lib/browser/vault-registry";
import { WriterGatedFS } from "@/lib/vault/gated-fs";
import type { VaultFileSystem } from "@/lib/vault/fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import {
  LEGACY_WRITER_LOCK_NAME,
  acquireVaultWriterLock,
  onVaultWriterStolen,
  waitForVaultWriterPromotion,
  type VaultLock,
} from "@/lib/vault/web-locks";
import { loadSyncConfig } from "@/lib/browser/sync-config";
import { writeSeedMarker } from "@/lib/browser/seed-marker";

/**
 * Whether this tab is the vault's writer, or read-only because another tab
 * already holds the writer lock (§12).
 *
 * A read-only tab can `takeOver()`: explicitly steal the writer lock now
 * ("Use here"). It is also promoted automatically, in place, the moment the
 * current writer tab releases (closes/navigates away) — its queued
 * `waitForVaultWriterPromotion` request is granted, and it keeps that same
 * granted lock and becomes the writer without reloading (see
 * `becomeWriter` below). Reloading here would destroy this tab's lock
 * client and let a third queued tab win the race instead, so neither path
 * reloads while holding the lock.
 */
export type VaultAccessStatus =
  | { kind: "writer" }
  | {
      kind: "read-only";
      takeOver: () => void;
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
export function shouldSeedWelcomeNote(vaultId?: string): boolean {
  return loadSyncConfig(vaultId) === null;
}

let singleton: VaultEngine | null = null;
let booting: Promise<VaultEngine> | null = null;
let vaultFs: WriterGatedFS | null = null;
let currentVault: VaultInfo | null = null;

/** The vault this page has open (set once getVault() has resolved it). */
export function getCurrentVault(): VaultInfo | null {
  return currentVault;
}

/** The whole origin's OPFS, where the vault registry and every vault live. */
export function originFileSystem(): VaultFileSystem {
  return new OpfsVaultFS([]);
}

/**
 * Before any vault opens: move the pre-multi-vault layout into place (under
 * the old writer lock, so a tab of an older build can't write the old root
 * mid-copy), then pick the vault this page shows.
 */
async function openVaultLayout(): Promise<VaultInfo> {
  const origin = originFileSystem();
  await navigator.locks.request(LEGACY_WRITER_LOCK_NAME, () => migrateLegacyVaultRoot(origin));
  const vault = await resolveVault(origin, window.location.pathname);
  rememberVault(vault.id);
  currentVault = vault;
  return vault;
}

/**
 * The file system the open vault uses. Anything else that writes into the
 * vault (the sync host's journal) must share it: it carries the writer-lock
 * gate and the per-path write queue, which only serialises writes made
 * through the same instance.
 */
export function getVaultFileSystem(): VaultFileSystem {
  if (!vaultFs) throw new Error("getVaultFileSystem() called before getVault()");
  return vaultFs;
}

/**
 * Boot the vault in the browser (single writer per origin).
 *
 * The lock is acquired for the whole session so the offline kernel owns the
 * store; other tabs stay read-only (§12).
 */
/**
 * Browsers only expose OPFS (where the whole vault lives) in a secure
 * context: https, or http on localhost. Served over plain http from a LAN
 * address — the common self-hosting mistake — `navigator.storage` is
 * simply absent, and the first vault call dies with an opaque
 * "undefined is not an object" TypeError. Fail early with something the
 * user can act on instead; VaultApp renders this message verbatim.
 */
function assertStorageAvailable(): void {
  const storage: StorageManager | undefined =
    typeof navigator === "undefined" ? undefined : navigator.storage;
  if (typeof storage?.getDirectory === "function") return;

  const origin = typeof window === "undefined" ? "this address" : window.location.origin;
  const secure = typeof window !== "undefined" && window.isSecureContext;
  if (!secure) {
    throw new Error(
      `Methyl stores your notes in the browser, which needs a secure connection. ` +
        `${origin} is plain http, so the browser blocks storage entirely. ` +
        `Open the app over https (a reverse proxy or Tailscale will do it), or use http://localhost on this machine.`,
    );
  }
  throw new Error(
    `This browser doesn't support the storage Methyl needs (OPFS). ` +
      `Private or incognito windows often block it — try a normal window, or a current Chrome, Edge, Safari or Firefox.`,
  );
}

export async function getVault(): Promise<VaultEngine> {
  if (singleton) return singleton;
  if (booting) return booting;

  booting = (async () => {
    assertStorageAvailable();
    const vault = await openVaultLayout();
    const vaultId = vault.id;
    // Every store write goes through this gate: only the tab holding the
    // writer lock may touch the vault (§12), whatever code path tries.
    const fs = new WriterGatedFS(new OpfsVaultFS(vaultRootParts(vaultId)));
    vaultFs = fs;
    const treeStore = new OpfsVaultTreeStore(fs);
    const docStore = new OpfsDocStore(fs);

    const lock = await acquireVaultWriterLock(vaultId);
    fs.setWritable(lock.active);
    markBoot("lock-acquired");
    // `.adhd/` → `.methyl/`: before anything reads the stores. Only the
    // writer tab may write, so only it migrates.
    if (lock.active) await migrateLegacyMetaDir(fs);
    if (!lock.active) {
      // Second tab: open read-only until a takeover is requested or this
      // tab is naturally promoted once the writer tab releases.
      const { engine } = await VaultEngine.open(treeStore, docStore, vaultId, { lazyDocuments: true });
      singleton = engine;

      // Queue in the background for the writer lock to become free
      // naturally (the current writer tab closes/navigates away) — no
      // polling: the browser grants this the moment it's free. Aborted on
      // tab close, and also on an explicit takeOver() from this same tab
      // (see becomeWriter) so this tab doesn't end up queued behind a lock
      // it already holds via steal.
      const promotionAbort = new AbortController();
      let becameWriterOnce = false;

      // Promote this tab in place — it keeps whichever granted VaultLock
      // got it here (natural promotion or an explicit steal) and becomes
      // the writer without reloading. Reloading would tear down this tab's
      // lock client and hand the lock to whichever tab is next in the
      // Web Locks FIFO queue instead of this one (see module doc).
      const becomeWriter = async (writerLock: VaultLock) => {
        if (becameWriterOnce) {
          // Already promoted via the other path (steal vs. natural
          // promotion racing each other) — this grant is redundant.
          writerLock.release();
          return;
        }
        becameWriterOnce = true;
        promotionAbort.abort();
        fs.setWritable(true);

        engine.releaseWriterLock = () => writerLock.release();
        if (typeof window !== "undefined") {
          window.addEventListener("pagehide", () => writerLock.release(), { once: true });
        }
        // From here on this tab is the writer, so it needs the same
        // steal-victim handling the original writer path has.
        onVaultWriterStolen(vaultId, () => {
          fs.setWritable(false);
          if (typeof window !== "undefined") window.location.reload();
        });
        watchVisibilityForExternalChanges(engine);

        // Writer-only boot work the read-only open above skipped:
        // reconcile the on-disk .md tree against the CRDT tree+content now
        // that this tab owns writes (see the same call in the first-boot
        // writer path below for what it catches). Creating a fresh vault /
        // seeding the welcome note doesn't apply here — a vault already
        // exists, since a previous tab was writing to it.
        try {
          engine.forgetCachedDocIndex();
          await engine.reconcileMaterialization();
        } catch (err) {
          console.error("[vault] reconcile on promotion failed", err);
        }

        setAccessStatus({ kind: "writer" });
      };

      const takeOver = () => {
        void acquireVaultWriterLock(vaultId, { steal: true }).then((stolen) => {
          if (stolen.active) void becomeWriter(stolen);
        });
      };
      setAccessStatus({ kind: "read-only", takeOver });

      waitForVaultWriterPromotion(vaultId, promotionAbort.signal)
        .then((promoted) => {
          if (!promoted.active) return;
          void becomeWriter(promoted);
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
      const opened = await VaultEngine.open(treeStore, docStore, vaultId, { lazyDocuments: true });
      engine = opened.engine;
      markBoot("vault-opened");
      // Reconcile the on-disk .md tree against the CRDT tree+content: this
      // catches the legacy-id-comment migration (content changed, so the
      // file is now stale), any file that was missing/stale from a crash
      // mid-write, and any orphaned file left behind by a rename/move that
      // didn't finish persisting. It reads and hashes every note, so it runs
      // in the background once the app is on screen rather than before
      // (spec item 20).
      reconcileInBackground(engine);
    } else if ((await docStore.listMaterializedPaths()).length > 0) {
      // No vault tree, but files on disk: the CRDT state is missing (the
      // "vault wipe" left exactly this), or files were put here before the
      // app ever ran. Adopt them — a new tree, no welcome note — instead of
      // showing an empty vault with the notes invisible beside it.
      engine = await VaultEngine.create(treeStore, docStore, vaultId);
      reconcileInBackground(engine);
    } else if (!shouldSeedWelcomeNote(vaultId)) {
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
      engine = await VaultEngine.create(treeStore, docStore, vaultId);
    } else {
      engine = await createFreshVault(fs, treeStore, docStore, vaultId);
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
    onVaultWriterStolen(vaultId, () => {
      // Stop writing now; the reload that follows reopens read-only.
      fs.setWritable(false);
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
 * Run the startup reconcile shortly after the app has rendered. It is safe
 * alongside normal use: ingest passes are serialised in the engine, and the
 * orphan sweep decides what to keep from the tree as it is when it sweeps.
 */
function reconcileInBackground(engine: VaultEngine): void {
  const run = () => {
    engine
      .reconcileMaterialization()
      .then(({ ingested, removed }) => {
        markBoot("reconciled");
        const changed =
          ingested.edited.length + ingested.moved.length + ingested.copied.length +
          ingested.created.length + ingested.deleted.length + removed.length +
          (ingested.foldersCreated?.length ?? 0) + (ingested.assetsCreated?.length ?? 0);
        // The app is already on screen: tell it to re-read the tree.
        if (changed > 0) window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
      })
      .catch((err) => console.error("[vault] background reconcile failed", err));
  };
  if (typeof window === "undefined") run();
  else window.setTimeout(run, RECONCILE_DELAY_MS);
}

const RECONCILE_DELAY_MS = 1500;

/** Window event: the vault changed outside the UI's own actions (background reconcile). */
export const VAULT_CHANGED_EVENT = "methyl:vault-changed";

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
  fs: VaultFileSystem,
  treeStore: OpfsVaultTreeStore,
  docStore: OpfsDocStore,
  vaultId: string,
): Promise<VaultEngine> {
  const engine = await VaultEngine.create(treeStore, docStore, vaultId);
  const welcome = `# Welcome

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