import { OpfsVaultFS } from "@/lib/vault/opfs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { acquireVaultWriterLock } from "@/lib/vault/web-locks";

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
      // Second tab: open read-only until takeover is requested
      const { engine } = await VaultEngine.open(treeStore, docStore, "local");
      singleton = engine;
      return engine;
    }

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
    } else {
      engine = await createFreshVault(treeStore, docStore);
    }
    engine.releaseWriterLock = () => lock.release();
    singleton = engine;
    return engine;
  })();

  try {
    return await booting;
  } finally {
    booting = null;
  }
}

/**
 * Seed a demo note so the first run is not a blank void. Called only when no
 * vault exists yet.
 */
async function createFreshVault(
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
  return engine;
}