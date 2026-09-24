import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";
import { exportFileName, exportVaultZip } from "@/lib/vault/export";

async function vaultWithContent() {
  const fs = new MemoryVaultFS();
  const engine = await VaultEngine.create(new OpfsVaultTreeStore(fs), new OpfsDocStore(fs), "local");
  const folder = engine.createFolder(undefined, "Projects");
  const note = engine.createDocument(folder, "Plan.md", "# Plan\n");
  const home = engine.createDocument(undefined, "Home.md", "See [[Plan]]\n");
  await engine.persistTree();
  await engine.persistDocumentIncremental(note.id);
  await engine.persistDocumentIncremental(home.id);
  await engine.createAttachment("diagram.png", new Uint8Array([137, 80, 78, 71]));
  await fs.writeFile("Home.md.tmp", new TextEncoder().encode("half-written"));
  return { fs, engine, noteId: note.id };
}

async function unzip(blob: Blob) {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

describe("vault export", () => {
  it("portable export holds the notes and attachments in their folders, and nothing else", async () => {
    const { fs } = await vaultWithContent();
    const files = await unzip(await exportVaultZip(fs, "portable"));

    expect(Object.keys(files).sort()).toEqual(["Attachments/diagram.png", "Home.md", "Projects/Plan.md"]);
    expect(new TextDecoder().decode(files["Projects/Plan.md"])).toBe("# Plan\n");
    expect([...files["Attachments/diagram.png"]!]).toEqual([137, 80, 78, 71]);
  });

  it("full backup adds the metadata, and restores to the same notes and history", async () => {
    const { fs, noteId } = await vaultWithContent();
    const progress: number[] = [];
    const files = await unzip(await exportVaultZip(fs, "full", (p) => progress.push(p.files)));

    expect(Object.keys(files).some((p) => p.startsWith(".adhd/crdt/"))).toBe(true);
    expect(Object.keys(files).some((p) => p.endsWith(".tmp"))).toBe(false);
    expect(progress.at(-1)).toBe(Object.keys(files).length);

    const restored = new MemoryVaultFS();
    for (const [path, data] of Object.entries(files)) await restored.writeFile(path, data);
    const { engine } = await VaultEngine.open(new OpfsVaultTreeStore(restored), new OpfsDocStore(restored), "local");
    expect(engine.getDocument(noteId)?.getText(CONTENT_KEY).toString()).toBe("# Plan\n");
  });

  it("names the archive by mode and date", () => {
    const at = new Date("2026-09-24T10:00:00Z");
    expect(exportFileName("portable", at)).toBe("methyl-vault-2026-09-24.zip");
    expect(exportFileName("full", at)).toBe("methyl-backup-2026-09-24.zip");
  });
});
