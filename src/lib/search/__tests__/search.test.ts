import { describe, it, expect, beforeEach } from "vitest";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import {
  SearchIndex,
  DerivedIndexes,
  toIndexedDocument,
} from "@/lib/search/index";
import { parseMarkdown } from "@/lib/core/markdown";
import type { ParsedDocument } from "@/lib/core/types";

const NOTE_A = `---
title: Garage
tags: [hardware, tools]
---

# Garage

The garage needs a new [[Recipes|recipe for shelving]].
`;

const NOTE_B = `---
title: Recipes
tags: [cooking]
---

# Recipes

A simple pasta [[Garage|dish for the garage sale]].
`;

function mkDoc(
  md: string,
  path: string,
): { indexed: ReturnType<typeof toIndexedDocument>; parsed: ParsedDocument } {
  const parsed = parseMarkdown(md, path);
  const indexed = toIndexedDocument(parsed, path, parsed.id);
  return { indexed, parsed };
}

describe("SearchIndex", () => {
  let fs: MemoryVaultFS;
  let idx: SearchIndex;

  beforeEach(() => {
    fs = new MemoryVaultFS();
    idx = new SearchIndex(fs);
  });

  it("add + search by tag", () => {
    const a = mkDoc(NOTE_A, "Inbox/Garage.md");
    const b = mkDoc(NOTE_B, "Recipes.md");
    idx.add(a.indexed);
    idx.add(b.indexed);

    const results = idx.search("hardware", 50);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(a.indexed.id);
  });

  it("add + search by title", () => {
    const a = mkDoc(NOTE_A, "Inbox/Garage.md");
    idx.add(a.indexed);

    const results = idx.search("Garage", 50);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Garage");
  });

  it("add deduplicates by id", () => {
    const a = mkDoc(NOTE_A, "Inbox/Garage.md");
    idx.add(a.indexed);
    idx.add({ ...a.indexed, title: "Updated title" });
    expect(idx.size).toBe(1);
    expect(idx.all()[0].title).toBe("Updated title");
  });

  it("remove is idempotent for documents not yet indexed", () => {
    expect(() => idx.remove("arrived-before-tree")).not.toThrow();
    expect(idx.size).toBe(0);
  });

  it("remove + persist/load round trip", async () => {
    const a = mkDoc(NOTE_A, "Inbox/Garage.md");
    const b = mkDoc(NOTE_B, "Recipes.md");
    idx.add(a.indexed);
    idx.add(b.indexed);
    idx.remove(a.indexed.id);
    expect(idx.size).toBe(1);

    await idx.persist();

    const loaded = new SearchIndex(fs);
    const ok = await loaded.load();
    expect(ok).toBe(true);
    expect(loaded.size).toBe(1);
    expect(loaded.all()[0].id).toBe(b.indexed.id);

    const results = loaded.search("cooking", 50);
    expect(results.length).toBe(1);
  });

  it("load returns false on missing file", async () => {
    const ok = await idx.load();
    expect(ok).toBe(false);
  });

  it("load returns false on corrupt file", async () => {
    await fs.mkdir(".adhd/cache");
    await fs.writeTextAtomic(".adhd/cache/search.json", "NOT JSON!!!");
    const ok = await idx.load();
    expect(ok).toBe(false);
    expect(idx.size).toBe(0);
  });

  it("rebuild regenerates the full index", async () => {
    const a = mkDoc(NOTE_A, "Inbox/Garage.md");
    const b = mkDoc(NOTE_B, "Recipes.md");
    idx.add(a.indexed);
    idx.add(b.indexed);
    await idx.persist();

    // Wipe and rebuild
    idx = new SearchIndex(fs);
    await idx.rebuild([a.indexed, b.indexed]);
    expect(idx.size).toBe(2);

    const loaded = new SearchIndex(fs);
    await loaded.load();
    expect(loaded.size).toBe(2);
    expect(loaded.search("pasta").length).toBe(1);
  });
});

describe("DerivedIndexes", () => {
  let fs: MemoryVaultFS;
  let derived: DerivedIndexes;

  beforeEach(() => {
    fs = new MemoryVaultFS();
    derived = new DerivedIndexes(fs);
  });

  it("backlinks detected from wikilinks", async () => {
    const a = mkDoc(NOTE_A, "Inbox/Garage.md");
    const b = mkDoc(NOTE_B, "Recipes.md");
    await derived.build([a.indexed, b.indexed]);

    // NOTE_A references Recipes via wikilink
    const bBacklinks = derived.backlinksFor(b.indexed.id);
    expect(bBacklinks.length).toBe(1);
    expect(bBacklinks[0].from).toBe(a.indexed.id);
  });

  it("bare filename links resolve when a note has a different heading", async () => {
    const target = mkDoc("# Target\n\nDestination", "Inbox/Untitled.md");
    const source = mkDoc("See [[Untitled]] for details.", "Source.md");
    await derived.build([target.indexed, source.indexed]);

    expect(derived.backlinksFor(target.indexed.id)).toEqual([
      expect.objectContaining({ from: source.indexed.id }),
    ]);
  });

  it("self-links are excluded", async () => {
    const self: ParsedDocument = {
      id: "self",
      title: "Self",
      headings: ["Me"],
      wikilinks: ["Self"],
      links: [],
      tags: [],
      aliases: [],
      frontmatter: {},
      body: "",
    };
    await derived.build([toIndexedDocument(self, "Self.md", "self")]);
    expect(derived.backlinksFor("self").length).toBe(0);
  });

  it("external links ignored for graph edges", async () => {
    const doc: ParsedDocument = {
      id: "ext",
      title: "Ext",
      headings: [],
      wikilinks: [],
      links: ["https://example.com", "internal.md"],
      tags: [],
      aliases: [],
      frontmatter: {},
      body: "",
    };
    await derived.build([toIndexedDocument(doc, "Ext.md", "ext")]);
    const edges = derived.graphTargetsFor("ext");
    expect(edges).toEqual(["internal"]);
  });

  it("persist/load round trip", async () => {
    const a = mkDoc(NOTE_A, "Inbox/Garage.md");
    const b = mkDoc(NOTE_B, "Recipes.md");
    await derived.build([a.indexed, b.indexed]);

    const fresh = new DerivedIndexes(fs);
    await fresh.load();
    expect(fresh.backlinksFor(b.indexed.id).length).toBe(1);
    expect(fresh.graphTargetsFor(a.indexed.id)).toEqual([b.indexed.id]);
  });

  it("allEdges returns full edge set", async () => {
    const a = mkDoc(NOTE_A, "Inbox/Garage.md");
    const b = mkDoc(NOTE_B, "Recipes.md");
    await derived.build([a.indexed, b.indexed]);
    const edges = derived.allEdges();
    expect(edges.length).toBe(2);
    expect(edges[0][0]).toBe(a.indexed.id);
  });

  it("load handles missing files gracefully", async () => {
    await derived.load();
    expect(derived.allEdges()).toEqual([]);
  });

  it("load handles corrupt files gracefully", async () => {
    await fs.mkdir(".adhd/cache");
    await fs.writeTextAtomic(
      ".adhd/cache/backlinks.json",
      "CORRUPT",
    );
    await derived.load();
    expect(derived.allEdges()).toEqual([]);
  });
});
