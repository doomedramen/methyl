import { LEGACY_META_DIRS, META_DIR } from "@/lib/core/paths";
import type { TreeID } from "loro-crdt";
import type { VaultTree, VaultTreeNode } from "@/lib/vault/tree";

/** Constants and tree/path helpers shared by the vault engine's modules. */
export const ATTACHMENTS_FOLDER_NAME = "Attachments";

export const IGNORED_EXTERNAL_DIRECTORY_SEGMENTS = new Set([
  META_DIR,
  ...LEGACY_META_DIRS,
  ".git",
  ".obsidian",
  ".trash",
  "node_modules",
]);

/** Return whether a materialized path belongs to app/tool metadata. */
export function isIgnoredExternalPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.endsWith(".tmp") || normalized
    .split("/")
    .some((segment) => IGNORED_EXTERNAL_DIRECTORY_SEGMENTS.has(segment.toLowerCase()));
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** Where the sidecar doc index (SPEC §5) lives, relative to the vault root. */
export const DOC_INDEX_PATH = `${META_DIR}/index.json`;

/** How many documents' stored state is read at once when opening a vault. */
export const DOC_LOAD_CONCURRENCY = 16;

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight; keeps order. */
export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** How long derived-cache writes wait for more changes to batch. */
export const INDEX_PERSIST_DEBOUNCE_MS = 400;

/** Derived-cache writes are best-effort: log and carry on. */
export function skipCachePersist(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("writer lock")) return; // read-only tab: expected
  console.error("[indexes] failed to persist derived indexes", error);
}

/** True if `candidate` is `ancestorId` itself or a descendant of it. */
export function isDescendant(
  tree: VaultTree,
  candidate: TreeID,
  ancestorId: TreeID,
): boolean {
  let current = tree.tree.getNodeByID(candidate);
  while (current) {
    if (current.id === ancestorId) return true;
    current = current.parent() ?? undefined;
  }
  return false;
}

/** All markdown document IDs contained within a subtree (inclusive). */
export function collectDocumentIds(tree: VaultTree, rootTreeId: TreeID): string[] {
  const ids: string[] = [];
  const visit = (treeId: TreeID) => {
    const node = tree.getNode(treeId);
    if (node?.kind === "markdown" && node.documentId) ids.push(node.documentId);
    for (const child of tree.children(treeId)) visit(child.treeId);
  };
  visit(rootTreeId);
  return ids;
}

export function collectBinaryNodes(tree: VaultTree, rootTreeId: TreeID): VaultTreeNode[] {
  const nodes: VaultTreeNode[] = [];
  const visit = (treeId: TreeID) => {
    const node = tree.getNode(treeId);
    if (node?.kind === "binary") nodes.push(node);
    for (const child of tree.children(treeId)) visit(child.treeId);
  };
  visit(rootTreeId);
  return nodes;
}

/**
 * Post-merge sibling name collisions (two peers, offline, each
 * independently creating a same-named node before ever syncing — nothing
 * in the tree CRDT rejects that) are resolved as a *real* CRDT tree edit —
 * see VaultTree.resolveNameCollisions() — not computed virtually here at
 * materialize time. An earlier version of this function computed a
 * collision-free name on the fly, per call, from the current sibling set;
 * that's unsound: it was recomputed independently every time any sibling
 * in the group got (re-)materialized, at whatever moment that happened to
 * run, so two calls for the same group could each pick a different
 * "winner" depending on what else existed in the tree yet — silently
 * overwriting an already-written file when the winner changed between
 * calls. A one-time, real rename that propagates through normal tree sync
 * doesn't have that failure mode: once resolved, every replica's tree
 * (and therefore every future buildPathFromNode call) agrees for good.
 * Callers that just merged/imported tree updates must call
 * VaultEngine.resolveTreeNameCollisions() before relying on paths from
 * this function.
 */
export function buildPathFromNode(
  tree: VaultTree,
  node: VaultTreeNode,
): string | null {
  const parts: string[] = [];
  let current = tree.tree.getNodeByID(node.treeId);
  while (current) {
    const rawName = (current.data.get("name") as string) || "";
    const parent = current.parent();
    parts.unshift(rawName);
    current = parent ?? undefined;
  }
  return parts.join("/");
}
