import { describe, expect, it } from "vitest";
import type { TreeID } from "loro-crdt";
import { MemoryVaultFS } from "@/lib/vault/memory-fs";
import { OpfsDocStore, OpfsVaultTreeStore } from "@/lib/vault/opfs-store";
import { VaultEngine, buildPathFromNode } from "@/lib/vault/engine";
import { CONTENT_KEY } from "@/lib/core/document";

/**
 * Model-based fuzz test for the vault engine (spec item 1).
 *
 * Random sequences of in-app edits, external disk edits/creates/deletes and
 * engine restarts run against an in-memory vault, while a plain model
 * records what the vault must contain. After every step the engine's
 * documents, the tree's paths and the files on disk must all match the
 * model: a note never disappears unless the model deleted it.
 *
 * Seeded and reproducible: a failure prints its seed; rerun one with
 * FUZZ_SEED=<seed>. FUZZ_RUNS raises the number of sequences.
 */

const RUNS = Number(process.env.FUZZ_RUNS ?? 40);
const STEPS = Number(process.env.FUZZ_STEPS ?? 30);
const ONLY_SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : null;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ModelNote {
  path: string;
  content: string;
}

class Harness {
  readonly fs = new MemoryVaultFS();
  engine!: VaultEngine;
  /** docId → expected path and content. */
  readonly notes = new Map<string, ModelNote>();
  /** folder path → tree id. */
  readonly folders = new Map<string, TreeID>();
  private counter = 0;
  readonly log: string[] = [];

  constructor(private readonly rand: () => number) {}

  async boot(): Promise<void> {
    this.engine = await VaultEngine.create(new OpfsVaultTreeStore(this.fs), new OpfsDocStore(this.fs), "local");
    await this.engine.persistTree();
  }

  private pick<T>(items: T[]): T | undefined {
    return items.length === 0 ? undefined : items[Math.floor(this.rand() * items.length)];
  }

  private next(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  private text(): string {
    return `${this.next("line ")} ${Math.floor(this.rand() * 1e6)}\n`;
  }

  private folderFor(path: string): string {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }

  async step(): Promise<void> {
    const ops: Array<[number, () => Promise<void>]> = [
      [4, () => this.createNote()],
      [4, () => this.editNote()],
      [2, () => this.renameNote()],
      [2, () => this.moveNote()],
      [2, () => this.createFolder()],
      [1, () => this.deleteNote()],
      [3, () => this.externalEdit()],
      [2, () => this.externalCreate()],
      [1, () => this.externalDelete()],
      [2, () => this.restart()],
      [3, () => this.peerChange()],
    ];
    const total = ops.reduce((n, [w]) => n + w, 0);
    let roll = this.rand() * total;
    for (const [weight, op] of ops) {
      roll -= weight;
      if (roll < 0) return op();
    }
  }

  private async createNote(): Promise<void> {
    const folder = this.pick(["", ...this.folders.keys()])!;
    const name = `${this.next("n")}.md`;
    const content = this.text();
    const doc = this.engine.createDocument(folder ? this.folders.get(folder) : undefined, name, content);
    await this.engine.persistTree();
    await this.engine.persistDocumentIncremental(doc.id);
    this.notes.set(doc.id, { path: folder ? `${folder}/${name}` : name, content });
    this.log.push(`create ${name} in "${folder}"`);
  }

  private async editNote(): Promise<void> {
    const id = this.pick([...this.notes.keys()]);
    if (!id) return;
    const addition = this.text();
    this.engine.getDocument(id)!.getText(CONTENT_KEY).insert(0, addition);
    await this.engine.persistDocumentIncremental(id);
    this.notes.get(id)!.content = addition + this.notes.get(id)!.content;
    this.log.push(`edit ${this.notes.get(id)!.path}`);
  }

  private async renameNote(): Promise<void> {
    const id = this.pick([...this.notes.keys()]);
    if (!id) return;
    const name = this.next("r");
    await this.engine.renameDocument(id, name);
    await this.engine.persistTree();
    const note = this.notes.get(id)!;
    const folder = this.folderFor(note.path);
    this.log.push(`rename ${note.path} -> ${name}.md`);
    note.path = folder ? `${folder}/${name}.md` : `${name}.md`;
  }

  private async moveNote(): Promise<void> {
    const id = this.pick([...this.notes.keys()]);
    if (!id) return;
    const target = this.pick(["", ...this.folders.keys()])!;
    const node = this.engine.tree.findByDocumentId(id)!;
    await this.engine.moveNode(node.treeId, target ? this.folders.get(target) : undefined);
    await this.engine.persistTree();
    const note = this.notes.get(id)!;
    const name = note.path.slice(note.path.lastIndexOf("/") + 1);
    this.log.push(`move ${note.path} -> "${target}"`);
    note.path = target ? `${target}/${name}` : name;
  }

  private async createFolder(): Promise<void> {
    const parent = this.pick(["", ...this.folders.keys()])!;
    // Keep nesting shallow so paths stay readable in failure logs.
    if (parent.split("/").length > 2) return;
    const name = this.next("f");
    const treeId = this.engine.createFolder(parent ? this.folders.get(parent) : undefined, name);
    await this.engine.persistTree();
    this.folders.set(parent ? `${parent}/${name}` : name, treeId);
    this.log.push(`mkdir ${parent ? `${parent}/` : ""}${name}`);
  }

  private async deleteNote(): Promise<void> {
    const id = this.pick([...this.notes.keys()]);
    if (!id) return;
    this.log.push(`delete ${this.notes.get(id)!.path}`);
    await this.engine.deleteDocument(id);
    this.notes.delete(id);
  }

  private async externalEdit(): Promise<void> {
    const id = this.pick([...this.notes.keys()]);
    if (!id) return;
    const note = this.notes.get(id)!;
    const content = note.content + this.text();
    await this.fs.writeFile(note.path, new TextEncoder().encode(content));
    await this.engine.ingestExternalChanges();
    note.content = content;
    this.log.push(`external edit ${note.path}`);
  }

  private async externalCreate(): Promise<void> {
    const folder = this.pick(["", ...this.folders.keys()])!;
    const name = `${this.next("x")}.md`;
    const path = folder ? `${folder}/${name}` : name;
    const content = this.text();
    await this.fs.writeFile(path, new TextEncoder().encode(content));
    const report = await this.engine.ingestExternalChanges();
    expect(report.created.length, `external create ${path} was not adopted`).toBe(1);
    this.notes.set(report.created[0]!, { path, content });
    this.log.push(`external create ${path}`);
  }

  private async externalDelete(): Promise<void> {
    // The engine refuses to delete half the vault in one pass (a safety
    // rail); one file out of three or more is an ordinary deletion.
    if (this.notes.size < 3) return;
    const id = this.pick([...this.notes.keys()])!;
    const note = this.notes.get(id)!;
    await this.fs.delete(note.path);
    const report = await this.engine.ingestExternalChanges();
    expect(report.deleted, `external delete of ${note.path} was not applied`).toContain(id);
    this.notes.delete(id);
    this.log.push(`external delete ${note.path}`);
  }

  private peer: VaultEngine | null = null;

  /**
   * Another device changes the vault and the change arrives by sync. The
   * peer pulls this vault's state, makes one change, and this engine then
   * imports the peer's tree and documents and runs exactly what SyncHost
   * runs after a round (resolve name collisions, persist the tree, persist
   * each touched document).
   */
  private async peerChange(): Promise<void> {
    if (!this.peer) {
      const peerFs = new MemoryVaultFS();
      this.peer = await VaultEngine.create(new OpfsVaultTreeStore(peerFs), new OpfsDocStore(peerFs), "local");
    }
    const peer = this.peer;
    peer.tree.doc.import(this.engine.tree.doc.export({ mode: "snapshot" }));
    for (const id of this.engine.tree.documentIds()) {
      const doc = this.engine.getDocument(id);
      if (doc) peer.ensureDocument(id).doc.import(doc.doc.export({ mode: "snapshot" }));
    }

    const ids = [...this.notes.keys()];
    const roll = this.rand();
    if (roll < 0.35 && ids.length > 0) {
      const id = this.pick(ids)!;
      const addition = this.text();
      peer.getDocument(id)!.getText(CONTENT_KEY).insert(0, addition);
      peer.getDocument(id)!.doc.commit();
      this.notes.get(id)!.content = addition + this.notes.get(id)!.content;
      this.log.push(`peer edit ${this.notes.get(id)!.path}`);
    } else if (roll < 0.6 || ids.length === 0) {
      const name = `${this.next("p")}.md`;
      const content = this.text();
      const doc = peer.createDocument(undefined, name, content);
      doc.doc.commit();
      this.notes.set(doc.id, { path: name, content });
      this.log.push(`peer create ${name}`);
    } else if (roll < 0.8) {
      const id = this.pick(ids)!;
      const name = this.next("pr");
      const node = peer.tree.findByDocumentId(id)!;
      peer.tree.rename(node.treeId, `${name}.md`);
      const note = this.notes.get(id)!;
      const folder = this.folderFor(note.path);
      this.log.push(`peer rename ${note.path} -> ${name}.md`);
      note.path = folder ? `${folder}/${name}.md` : `${name}.md`;
    } else {
      const id = this.pick(ids)!;
      peer.tree.delete(peer.tree.findByDocumentId(id)!.treeId);
      this.log.push(`peer delete ${this.notes.get(id)!.path}`);
      this.notes.delete(id);
    }
    peer.tree.doc.commit();

    this.engine.tree.doc.import(peer.tree.doc.export({ mode: "snapshot" }));
    const touched = peer.tree.documentIds();
    for (const id of touched) {
      const doc = peer.getDocument(id);
      if (doc) await this.engine.importDocumentUpdate(id, doc.doc.export({ mode: "snapshot" }));
    }
    await this.engine.resolveTreeNameCollisions();
    await this.engine.persistTreeIncremental();
    await this.engine.applyTreeToDisk();
    for (const id of touched) {
      if (this.engine.tree.findByDocumentId(id)) await this.engine.persistDocumentIncremental(id);
    }
  }

  private async restart(): Promise<void> {
    const { engine } = await VaultEngine.open(new OpfsVaultTreeStore(this.fs), new OpfsDocStore(this.fs), "local");
    this.engine = engine;
    await this.engine.reconcileMaterialization();
    this.log.push("restart");
  }

  async check(): Promise<void> {
    const docIds = this.engine.tree
      .allNodes()
      .filter((n) => n.kind === "markdown" && n.documentId)
      .map((n) => n.documentId!);
    expect(new Set(docIds), "tree documents").toEqual(new Set(this.notes.keys()));

    for (const [id, note] of this.notes) {
      const doc = this.engine.getDocument(id);
      expect(doc, `document ${note.path} missing from engine`).toBeDefined();
      expect(doc!.getText(CONTENT_KEY).toString(), `content of ${note.path}`).toBe(note.content);
      const node = this.engine.tree.findByDocumentId(id)!;
      expect(buildPathFromNode(this.engine.tree, node), `tree path of ${id}`).toBe(note.path);
      expect(await this.fs.readTextFile(note.path), `file ${note.path}`).toBe(note.content);
    }

    const onDisk: string[] = [];
    for await (const { path } of this.fs.walk()) if (path.endsWith(".md")) onDisk.push(path);
    expect(new Set(onDisk), "Markdown files on disk").toEqual(new Set([...this.notes.values()].map((n) => n.path)));
  }
}

describe("vault engine fuzz", () => {
  const seeds = ONLY_SEED !== null ? [ONLY_SEED] : Array.from({ length: RUNS }, (_, i) => 1000 + i);

  it(`keeps every note through ${seeds.length} random sequences of ${STEPS} steps`, async () => {
    for (const seed of seeds) {
      const harness = new Harness(mulberry32(seed));
      await harness.boot();
      try {
        for (let i = 0; i < STEPS; i++) {
          await harness.step();
          await harness.check();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `fuzz seed ${seed} failed (rerun with FUZZ_SEED=${seed}):\n${message}\n` +
            `steps:\n  ${harness.log.join("\n  ")}`,
        );
      }
    }
  }, 120_000);
});
