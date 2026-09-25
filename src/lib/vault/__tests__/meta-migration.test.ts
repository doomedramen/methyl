import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";
import { migrateLegacyMetaDir } from "@/lib/vault/meta-migration";
import { migrateLegacyMetaDirOnDisk } from "@/lib/server/meta-migration";
import type { VaultFileSystem } from "@/lib/vault/fs";

const text = (s: string) => new TextEncoder().encode(s);

/** A vault written under the legacy `.adhd/` layout, as older builds did. */
async function legacyVault() {
  const staging = new MemoryVaultFS();
  const engine = await VaultEngine.create(new OpfsVaultTreeStore(staging), new OpfsDocStore(staging), "local");
  const doc = engine.createDocument(undefined, "note.md", "kept across the rename\n");
  await engine.persistTree();
  await engine.persistDocumentIncremental(doc.id);
  const legacy = new MemoryVaultFS();
  for await (const { path } of staging.walk()) await legacy.writeFile(path, (await staging.readFile(path))!);
  const copyMeta = async (dir: string) => {
    const { dirs, files } = await staging.readdir(dir);
    for (const f of files) await legacy.writeFile(`.adhd${dir.slice(".methyl".length)}/${f}`, (await staging.readFile(`${dir}/${f}`))!);
    for (const d of dirs) await copyMeta(`${dir}/${d}`);
  };
  await copyMeta(".methyl");
  return { fs: legacy, docId: doc.id };
}

describe("browser metadata migration (.adhd → .methyl)", () => {
  it("moves the metadata and the vault opens with its notes", async () => {
    const { fs, docId } = await legacyVault();
    const report = await migrateLegacyMetaDir(fs);

    expect(report.migrated).toEqual([".adhd"]);
    expect((await fs.readdir(".adhd")).files).toEqual([]);
    const { engine } = await VaultEngine.open(new OpfsVaultTreeStore(fs), new OpfsDocStore(fs), "local");
    expect(engine.getDocument(docId)?.getText(CONTENT_KEY).toString()).toBe("kept across the rename\n");
    expect(await migrateLegacyMetaDir(fs)).toEqual({ migrated: [], files: 0 });
  });

  it("an interrupted copy leaves .adhd intact and the rerun completes it", async () => {
    const { fs, docId } = await legacyVault();
    let writes = 0;
    const failing: VaultFileSystem = Object.create(fs);
    failing.writeFile = async (path: string, data: Uint8Array) => {
      if (++writes === 3) throw new Error("tab closed");
      return fs.writeFile(path, data);
    };
    await expect(migrateLegacyMetaDir(failing)).rejects.toThrow("tab closed");
    expect((await fs.readdir(".adhd")).dirs.length).toBeGreaterThan(0);

    await migrateLegacyMetaDir(fs);
    const { engine } = await VaultEngine.open(new OpfsVaultTreeStore(fs), new OpfsDocStore(fs), "local");
    expect(engine.getDocument(docId)?.getText(CONTENT_KEY).toString()).toBe("kept across the rename\n");
  });

  it("an interrupted delete never copies stale legacy files over newer data", async () => {
    const { fs } = await legacyVault();
    let deletes = 0;
    const failing: VaultFileSystem = Object.create(fs);
    failing.delete = async (path: string, options?: { recursive?: boolean }) => {
      if (++deletes === 2) throw new Error("tab closed");
      return fs.delete(path, options);
    };
    await expect(migrateLegacyMetaDir(failing)).rejects.toThrow("tab closed");
    // The app runs and writes newer metadata...
    await fs.writeFile(".methyl/index.json", text('{"newer":true}'));
    // ...and the next start finishes the migration without overwriting it.
    await migrateLegacyMetaDir(fs);
    expect(await fs.readTextFile(".methyl/index.json")).toBe('{"newer":true}');
    expect((await fs.readdir(".adhd")).files).toEqual([]);
  });
});

describe("server metadata migration", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const vault = () => {
    const d = mkdtempSync(join(tmpdir(), "methyl-meta-"));
    dirs.push(d);
    return d;
  };

  it("renames .adhd to .methyl", () => {
    const v = vault();
    mkdirSync(join(v, ".adhd", "crdt"), { recursive: true });
    writeFileSync(join(v, ".adhd", "crdt", "x"), "x");
    expect(migrateLegacyMetaDirOnDisk(v)).toEqual([".adhd"]);
    expect(readFileSync(join(v, ".methyl", "crdt", "x"), "utf8")).toBe("x");
    expect(existsSync(join(v, ".adhd"))).toBe(false);
    expect(migrateLegacyMetaDirOnDisk(v)).toEqual([]);
  });

  it("refuses when both exist", () => {
    const v = vault();
    mkdirSync(join(v, ".adhd"));
    mkdirSync(join(v, ".methyl"));
    writeFileSync(join(v, ".methyl", "index.json"), "{}");
    expect(() => migrateLegacyMetaDirOnDisk(v)).toThrow(/both/);
  });
});
