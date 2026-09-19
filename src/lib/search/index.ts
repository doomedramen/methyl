import MiniSearch, { type AsPlainObject } from "minisearch";
import type { DocIndexEntry, ParsedDocument } from "@/lib/core/types";
import type { PersistedDocStore } from "@/lib/vault/store";

const CACHE_ROOT = ".adhd/cache";
const SEARCH_FILE = `${CACHE_ROOT}/search.json`;
const BACKLINKS_FILE = `${CACHE_ROOT}/backlinks.json`;
const GRAPH_FILE = `${CACHE_ROOT}/graph.json`;

/** §13 field weights: title 5, aliases 4, tags 3, headings 2, body 1. */
export const SEARCH_BOOST: Record<string, number> = {
  title: 5,
  aliases: 4,
  tags: 3,
  headings: 2,
  body: 1,
};

const SEARCHABLE_FIELDS = Object.keys(SEARCH_BOOST);
const STORE_FIELDS = ["title", "path", "tags"];

/** Storage needed by the derived indexes. */
export interface SearchIndexStorage {
  readTextFile(path: string): Promise<string | null>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** Adapt the vault's materialised-file store to the search cache interface. */
export function searchIndexStorageFromDocStore(
  docStore: Pick<PersistedDocStore, "readMaterialized" | "writeMaterializedAtomic">,
): SearchIndexStorage {
  return {
    async readTextFile(path) {
      const bytes = await docStore.readMaterialized(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    writeTextAtomic(path, text) {
      return docStore.writeMaterializedAtomic(path, new TextEncoder().encode(text));
    },
    // Materialised-file stores create parent directories as part of atomic writes.
    async mkdir() {},
  };
}

/** Document plus link metadata used by the derived backlink/graph indexes. */
export interface IndexedDocument extends DocIndexEntry {
  wikilinks: string[];
  links: string[];
}

function miniSearchOptions() {
  return {
    fields: SEARCHABLE_FIELDS,
    storeFields: STORE_FIELDS,
    searchOptions: {
      boost: SEARCH_BOOST,
      fuzzy: 0.2 as const,
      prefix: true,
    },
  };
}

/**
 * Full-text index over note content (§13). Persisted to .adhd/cache/search.json.
 * Tracks documents itself because MiniSearch cannot enumerate stored documents.
 */
export class SearchIndex {
  private fs: SearchIndexStorage;
  private index: MiniSearch;
  private docs = new Map<string, DocIndexEntry>();

  constructor(fs: SearchIndexStorage) {
    this.fs = fs;
    this.index = new MiniSearch(miniSearchOptions());
  }

  /** Load persisted index. Returns false on missing/corrupt cache (→ rebuild). */
  async load(): Promise<boolean> {
    const raw = await this.fs.readTextFile(SEARCH_FILE);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as {
        documents: DocIndexEntry[];
        serializedIndex: string;
      };
      this.index = MiniSearch.loadJSON(
        parsed.serializedIndex,
        miniSearchOptions(),
      );
      this.docs = new Map(parsed.documents.map((d) => [d.id, d]));
      return true;
    } catch {
      // Corrupt cache: caller should rebuild from Markdown
      this.index = new MiniSearch(miniSearchOptions());
      this.docs = new Map();
      return false;
    }
  }

  add(doc: DocIndexEntry): void {
    if (this.docs.has(doc.id)) this.index.discard(doc.id);
    this.docs.set(doc.id, doc);
    this.index.add(doc);
  }

  remove(id: string): void {
    // MiniSearch.discard throws when the document is absent. A document room
    // can arrive before its tree node, so index removal must be idempotent
    // while the server mirror waits for the tree save to catch up.
    if (this.index.has(id)) this.index.discard(id);
    this.docs.delete(id);
  }

  /** Replace the in-memory index without writing it to disk. */
  replaceAll(docs: DocIndexEntry[]): void {
    this.index = new MiniSearch(miniSearchOptions());
    this.docs = new Map();
    for (const doc of docs) this.add(doc);
  }

  search(query: string, limit = 50): DocIndexEntry[] {
    return this.index
      .search(query, { boost: SEARCH_BOOST, fuzzy: 0.2, prefix: true })
      .slice(0, limit) as unknown as DocIndexEntry[];
  }

  all(): DocIndexEntry[] {
    return [...this.docs.values()];
  }

  get size(): number {
    return this.docs.size;
  }

  async persist(): Promise<void> {
    await this.fs.mkdir(CACHE_ROOT);
    const payload = {
      documents: this.all(),
      serializedIndex: JSON.stringify(this.index.toJSON() as AsPlainObject),
    };
    await this.fs.writeTextAtomic(SEARCH_FILE, JSON.stringify(payload));
  }

  /** Rebuild the whole index from parsed documents. */
  async rebuild(docs: DocIndexEntry[]): Promise<void> {
    this.replaceAll(docs);
    await this.persist();
  }
}

export interface BacklinkEntry {
  from: string;
  fromTitle: string;
}

/** Plain serialized maps per §13 — backlinks and small link graph. */
export class DerivedIndexes {
  private fs: SearchIndexStorage;
  private backlinks = new Map<string, BacklinkEntry[]>();
  private graphEdges = new Map<string, string[]>();

  constructor(fs: SearchIndexStorage) {
    this.fs = fs;
  }

  async load(): Promise<void> {
    const backlinks = await this.readJson<Record<string, BacklinkEntry[]>>(
      BACKLINKS_FILE,
      {},
    );
    const graph = await this.readJson<Record<string, string[]>>(GRAPH_FILE, {});
    this.backlinks = new Map(Object.entries(backlinks));
    this.graphEdges = new Map(Object.entries(graph));
  }

  /** Rebuild backlinks + graph edges from parsed markdown metadata. */
  async build(docs: IndexedDocument[]): Promise<void> {
    this.backlinks.clear();
    this.graphEdges.clear();
    const byTitle = new Map<string, string>();
    for (const d of docs) {
      byTitle.set(d.title.toLowerCase(), d.id);
      byTitle.set(d.path.replace(/\.md$/i, "").toLowerCase(), d.id);
    }

    for (const doc of docs) {
      const targets: string[] = [];
      for (const link of doc.wikilinks) {
        const target = resolveWikilink(link, byTitle);
        if (!target || target === doc.id) continue;
        targets.push(target);
        const existing = this.backlinks.get(target) ?? [];
        if (!existing.some((entry) => entry.from === doc.id)) {
          existing.push({ from: doc.id, fromTitle: doc.title });
        }
        this.backlinks.set(target, existing);
      }
      const internal = doc.links
        .filter((l) => !/^[a-z][a-z0-9+.-]*:/i.test(l))
        .map((l) => l.replace(/\.md$/i, ""));
      const outgoing = [...new Set([...targets, ...internal])];
      if (outgoing.length) this.graphEdges.set(doc.id, outgoing);
    }
    await this.persist();
  }

  backlinksFor(id: string): BacklinkEntry[] {
    return this.backlinks.get(id) ?? [];
  }

  graphTargetsFor(id: string): string[] {
    return this.graphEdges.get(id) ?? [];
  }

  allEdges(): Array<[string, string[]]> {
    return [...this.graphEdges.entries()];
  }

  async persist(): Promise<void> {
    await this.fs.mkdir(CACHE_ROOT);
    await this.fs.writeTextAtomic(
      BACKLINKS_FILE,
      JSON.stringify(Object.fromEntries(this.backlinks)),
    );
    await this.fs.writeTextAtomic(
      GRAPH_FILE,
      JSON.stringify(Object.fromEntries(this.graphEdges)),
    );
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    const raw = await this.fs.readTextFile(path);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
}

function resolveWikilink(
  link: string,
  byTitle: Map<string, string>,
): string | null {
  const target = link.replace(/\.md$/i, "").split("#")[0].trim().toLowerCase();
  return byTitle.get(target) ?? null;
}

/** Adapt a parsed Markdown document into an indexable record. */
export function toIndexedDocument(
  parsed: ParsedDocument,
  path: string,
  id: string,
): IndexedDocument {
  return {
    id,
    title: parsed.title,
    path,
    body: parsed.body,
    tags: parsed.tags,
    aliases: parsed.aliases,
    headings: parsed.headings,
    wikilinks: parsed.wikilinks,
    links: parsed.links,
  };
}
