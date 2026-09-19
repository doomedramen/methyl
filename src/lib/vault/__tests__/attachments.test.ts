import { describe, expect, it } from "vitest";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine } from "@/lib/vault/engine";
import {
  attachmentMarkdownLink,
  findAttachmentNode,
  relativeAttachmentPath,
} from "@/lib/vault/attachments";

async function newEngine() {
  const fs = new MemoryVaultFS();
  const engine = await VaultEngine.create(new OpfsVaultTreeStore(fs), new OpfsDocStore(fs));
  return { engine, fs };
}

describe("attachment paths and portable Markdown", () => {
  it("encodes path segments and resolves relative paths from nested notes", async () => {
    const { engine } = await newEngine();
    const folder = engine.createFolder(undefined, "Projects");
    const note = engine.createDocument(folder, "Plan.md", "");
    const asset = await engine.createAttachment("diagram (final).png", new Uint8Array([1, 2]));

    const target = relativeAttachmentPath(engine, note.id, asset.treeId);

    expect(target).toBe("../Attachments/diagram%20%28final%29.png");
    expect(findAttachmentNode(engine, target!, note.id)?.treeId).toBe(asset.treeId);
    expect(attachmentMarkdownLink(asset.name, target!)).toBe(
      "![diagram (final).png](../Attachments/diagram%20%28final%29.png)",
    );
  });

  it("uses ordinary links for non-image attachments", async () => {
    const { engine } = await newEngine();
    const note = engine.createDocument(undefined, "Plan.md", "");
    const asset = await engine.createAttachment("data (raw).csv", new Uint8Array([3, 4]));
    const target = relativeAttachmentPath(engine, note.id, asset.treeId)!;

    expect(attachmentMarkdownLink(asset.name, target)).toBe(
      "[data (raw).csv](Attachments/data%20%28raw%29.csv)",
    );
  });
});
