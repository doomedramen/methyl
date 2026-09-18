import type { PersistedDocStore } from "@/lib/vault/store";

/**
 * Per-document graph layout (node x/y + viewport), vault-local and never
 * synced — SPEC §37: "Visual layout state ... belongs in ... not in
 * Markdown." Persisted the same way seed-marker.ts and diagnostics.ts are:
 * a plain JSON file under `.adhd/vault-meta/`, written directly via
 * `PersistedDocStore` (not through `VaultEngine`'s materialize path, which
 * is reserved for the Markdown mirror of tree-tracked documents).
 *
 * A graph opened on a device/vault copy that has never seen this file
 * (e.g. cloned from git, or a peer that synced only the `.md`) still
 * renders — GraphEditor falls back to an auto-layout when no stored layout
 * exists for a node — it just isn't dirtying the file.
 */

const LAYOUT_PATH = ".adhd/vault-meta/graph-layout.json";

export interface GraphNodeLayout {
  x: number;
  y: number;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

/** Per-node editor metadata that has no representation in the Mermaid
 * source (node kind, done state). Keyed by node id — ids are stable once a
 * node is written into the document, so this survives reloads and syncs. */
export interface GraphNodeMeta {
  kind?: "graph" | "todo";
  done?: boolean;
}

export interface GraphLayout {
  nodes: Record<string, GraphNodeLayout>;
  viewport?: GraphViewport;
  meta?: Record<string, GraphNodeMeta>;
  /** Edge animation preference (persisted per graph document). */
  animatedEdges?: boolean;
}

type LayoutFile = Record<string, GraphLayout>;

async function readAll(docStore: PersistedDocStore): Promise<LayoutFile> {
  try {
    const bytes = await docStore.readMaterialized(LAYOUT_PATH);
    if (!bytes) return {};
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as LayoutFile;
  } catch {
    return {};
  }
}

async function writeAll(docStore: PersistedDocStore, all: LayoutFile): Promise<void> {
  await docStore.writeMaterializedAtomic(
    LAYOUT_PATH,
    new TextEncoder().encode(JSON.stringify(all)),
  );
}

/** Read the stored layout for one graph document. `null` if never saved. */
export async function readGraphLayout(
  docStore: PersistedDocStore,
  documentId: string,
): Promise<GraphLayout | null> {
  const all = await readAll(docStore);
  return all[documentId] ?? null;
}

/** Write (replacing entirely) the stored layout for one graph document. */
export async function writeGraphLayout(
  docStore: PersistedDocStore,
  documentId: string,
  layout: GraphLayout,
): Promise<void> {
  const all = await readAll(docStore);
  all[documentId] = layout;
  await writeAll(docStore, all);
}

/** Drop a graph document's stored layout (e.g. when the note is deleted). */
export async function deleteGraphLayout(
  docStore: PersistedDocStore,
  documentId: string,
): Promise<void> {
  const all = await readAll(docStore);
  if (!(documentId in all)) return;
  delete all[documentId];
  await writeAll(docStore, all);
}
