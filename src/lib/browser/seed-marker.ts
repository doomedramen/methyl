import type { VaultFileSystem } from "@/lib/vault/fs";
import type { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";
import { sha256Text } from "@/lib/core/hash";

/**
 * Tracks the onboarding "Welcome" note seeded into a brand-new vault
 * (vault.ts's createFreshVault), so a later first-ever sync can tell
 * whether this vault is still *just* that untouched seed — and if so,
 * drop it before merging rather than letting it survive as a duplicate
 * sibling of whatever the peer(s) it's syncing with already have. This is
 * a vault-local meta key (a plain file under `.adhd/`, never synced —
 * VaultEngine's fs-store/materialize paths never touch `.adhd/vault-meta`
 * so it can't collide with anything real), not a guess based on the
 * note's name or content.
 */

const SEED_META_PATH = ".adhd/vault-meta/seed.json";
const SEED_CHECKED_PATH = ".adhd/vault-meta/seed-check-done";

export interface SeedMarker {
  documentId: string;
  contentSha256: string;
}

export async function writeSeedMarker(
  fs: VaultFileSystem,
  documentId: string,
  content: string,
): Promise<void> {
  const contentSha256 = await sha256Text(content);
  await fs.mkdir(".adhd/vault-meta");
  await fs.writeTextAtomic(
    SEED_META_PATH,
    JSON.stringify({ documentId, contentSha256 } satisfies SeedMarker),
  );
}

export async function readSeedMarker(fs: VaultFileSystem): Promise<SeedMarker | null> {
  const raw = await fs.readTextFile(SEED_META_PATH);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SeedMarker>;
    if (typeof parsed.documentId !== "string" || typeof parsed.contentSha256 !== "string") {
      return null;
    }
    return { documentId: parsed.documentId, contentSha256: parsed.contentSha256 };
  } catch {
    return null;
  }
}

/**
 * Drop the untouched onboarding seed note, if any, before this vault's
 * first-ever sync round merges in a peer's real notes. Runs at most once
 * per vault (marked via a `seed-check-done` file, written up front so a
 * failure partway through this function never leaves it re-checking
 * forever) and only acts when ALL of:
 *   - a seed was recorded for this vault (writeSeedMarker, at creation)
 *   - the vault still contains *only* that one document — no other notes,
 *     no folders — so this can't discard something the user actually
 *     added alongside it
 *   - that document's content still hashes to exactly what was seeded
 *     (never edited — an edited "Welcome" note is the user's now)
 *   - the server already has content for this vault (`serverHasContent`)
 *     — an empty server means this really is about to become the vault's
 *     first real note (from this device or the next one to connect), so
 *     it's kept rather than discarded into nothing
 *
 * Deleting via VaultEngine.deleteDocument only removes this one document's
 * own tree node + doc room — its documentId is unique to it, so this
 * can't affect (or "propagate a deletion" against) any other device's
 * notes, including another device's own still-untouched seed.
 */
export async function maybeDropUntouchedSeed(
  fs: VaultFileSystem,
  engine: VaultEngine,
  serverHasContent: () => Promise<boolean>,
): Promise<void> {
  const already = await fs.readTextFile(SEED_CHECKED_PATH);
  if (already) return;
  await fs.mkdir(".adhd/vault-meta");
  await fs.writeTextAtomic(SEED_CHECKED_PATH, "1");

  const marker = await readSeedMarker(fs);
  if (!marker) return;

  const docIds = engine.tree.documentIds();
  const isOnlyDoc = docIds.length === 1 && docIds[0] === marker.documentId;
  const hasNoOtherNodes = engine.tree.allNodes().length === docIds.length;
  if (!isOnlyDoc || !hasNoOtherNodes) return;

  const doc = engine.getDocument(marker.documentId);
  if (!doc) return;
  const currentHash = await sha256Text(doc.getText(CONTENT_KEY).toString());
  if (currentHash !== marker.contentSha256) return; // edited — it's the user's now, keep it

  if (!(await serverHasContent())) return; // fresh empty server — this IS the first real note

  await engine.deleteDocument(marker.documentId);
}
