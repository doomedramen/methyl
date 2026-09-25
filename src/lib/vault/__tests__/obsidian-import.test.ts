import { describe, expect, it } from "vitest";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { VaultEngine } from "@/lib/vault/engine";
import {
  importObsidianVault,
  prepareObsidianImport,
  type ObsidianImportEntry,
} from "@/lib/vault/obsidian-import";

async function newEngine() {
  const fs = new MemoryVaultFS();
  const engine = await VaultEngine.create(new OpfsVaultTreeStore(fs), new OpfsDocStore(fs));
  return { engine, fs };
}

function entry(path: string, content: string | Uint8Array): ObsidianImportEntry {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return { path, read: async () => bytes };
}

describe("Obsidian vault import", () => {
  it("keeps folders, Markdown, and binary files while skipping app metadata", async () => {
    const { engine, fs } = await newEngine();
    const progress: string[] = [];

    const report = await importObsidianVault(
      engine,
      [
        entry("Home.md", "# Home\n\n[[Projects/Plan]]"),
        entry("Projects/Plan.md", "# Plan"),
        entry("assets/diagram.png", new Uint8Array([1, 2, 3])),
        entry(".obsidian/app.json", "{}"),
        entry(".trash/deleted.md", "gone"),
        entry(".methyl/index.json", "{}"),
      ],
      ({ path }) => {
        progress.push(path);
      },
    );

    expect(report.notes).toBe(2);
    expect(report.files).toBe(1);
    expect(report.imported).toEqual(["Home.md", "Projects/Plan.md", "assets/diagram.png"]);
    expect(report.skipped).toHaveLength(3);
    expect(report.failed).toHaveLength(0);
    expect(progress).toEqual(["Home.md", "Projects/Plan.md", "assets/diagram.png"]);

    const home = engine.tree.resolvePath(["Home.md"]);
    const plan = engine.tree.resolvePath(["Projects", "Plan.md"]);
    const diagram = engine.tree.resolvePath(["assets", "diagram.png"]);
    expect(home).toBeDefined();
    expect(plan).toBeDefined();
    expect(diagram).toBeDefined();
    expect(engine.tree.getNode(diagram!)?.kind).toBe("binary");
    expect(engine.getDocument(engine.tree.getNode(home!)!.documentId!)?.getMarkdown()).toBe(
      "# Home\n\n[[Projects/Plan]]",
    );
    expect(await fs.readFile("assets/diagram.png")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects unsafe and duplicate paths before reading them", () => {
    let reads = 0;
    const { entries, skipped } = prepareObsidianImport([
      {
        path: "../outside.md",
        read: async () => {
          reads += 1;
          return new Uint8Array();
        },
      },
      entry("Notes/Idea.md", "one"),
      entry("notes/idea.md", "two"),
      entry("Notes/valid.md", "three"),
    ]);

    expect(entries.map(({ path }) => path)).toEqual(["Notes/Idea.md", "Notes/valid.md"]);
    expect(skipped.map(({ reason }) => reason)).toEqual(["path escapes vault root", "duplicate path"]);
    expect(reads).toBe(0);
  });

  it("normalizes uppercase Markdown extensions", () => {
    const { entries, skipped } = prepareObsidianImport([entry("Notes/README.MD", "# read me")]);

    expect(skipped).toHaveLength(0);
    expect(entries[0]?.path).toBe("Notes/README.md");
  });
});
