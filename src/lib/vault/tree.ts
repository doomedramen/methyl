import { LoroDoc, LoroTree, LoroMap, type OpId, type TreeID } from "loro-crdt";
import type { NodeKind } from "@/lib/core/types";
import { sanitizeName, uniqueName } from "@/lib/core/paths";

export const TREE_KEY = "vault-tree";

export interface VaultTreeNode {
  treeId: TreeID;
  name: string;
  kind: NodeKind;
  documentId?: string;
  sha256?: string;
  size?: number;
  mime?: string;
}

export interface BinaryFileMetadata {
  sha256: string;
  size?: number;
  mime?: string;
}

export class VaultTree {
  readonly doc: LoroDoc;
  readonly tree: LoroTree;

  constructor(doc?: LoroDoc) {
    this.doc = doc ?? new LoroDoc();
    this.tree = this.doc.getTree(TREE_KEY);
  }

  static create(): VaultTree {
    const vault = new VaultTree();
    return vault;
  }

  static fromSnapshot(snapshot: Uint8Array): VaultTree {
    const doc = new LoroDoc();
    doc.import(snapshot);
    return new VaultTree(doc);
  }

  snapshot(): Uint8Array {
    return this.doc.export({ mode: "snapshot" });
  }

  fork(): VaultTree {
    return new VaultTree(this.doc.fork());
  }

  exportUpdates(): Uint8Array {
    this.doc.commit();
    return this.doc.export({ mode: "update" });
  }

  import(bytes: Uint8Array): void {
    this.doc.import(bytes);
    this.doc.commit();
  }

  frontiers(): OpId[] {
    this.doc.commit();
    return this.doc.oplogFrontiers();
  }

  /**
   * Names collide case-insensitively (so "Note.md" and "note.md" can't
   * coexist in one folder — most filesystems users sync to are
   * case-insensitive too). Returns the lowercased sibling name set,
   * excluding `excludeTreeId` (used when renaming/moving a node past
   * itself).
   */
  private siblingNameSet(
    parent: TreeID | undefined,
    excludeTreeId?: TreeID,
  ): Set<string> {
    const parentNode = parent ? this.tree.getNodeByID(parent) : undefined;
    const siblings = parentNode ? parentNode.children() ?? [] : this.tree.roots();
    return new Set(
      siblings
        .filter((s) => !s.isDeleted() && s.id !== excludeTreeId)
        .map((s) => ((s.data.get("name") as string) || "").toLowerCase()),
    );
  }

  /** Add a directory node. Auto-suffixes on a case-insensitive name clash. */
  addDirectory(
    parent: TreeID | undefined,
    name: string,
    index?: number,
  ): TreeID {
    const safe = sanitizeName(name);
    if (!safe) throw new Error(`Invalid directory name: ${name}`);
    const taken = this.siblingNameSet(parent);
    const final = uniqueName(safe, (n) => taken.has(n.toLowerCase()));
    const node = this.tree.createNode(parent, index);
    node.data.set("name", final);
    node.data.set("kind", "directory");
    this.doc.commit();
    return node.id;
  }

  /**
   * Add a Markdown document node. Returns the new treeId. Auto-suffixes on
   * a case-insensitive name clash (e.g. "Untitled.md" -> "Untitled 2.md").
   */
  addMarkdownDocument(
    parent: TreeID | undefined,
    name: string,
    documentId: string,
    index?: number,
  ): TreeID {
    const safe = sanitizeName(name);
    if (!safe) throw new Error(`Invalid name: ${name}`);
    if (!safe.endsWith(".md")) throw new Error(`Markdown files must end with .md`);
    const taken = this.siblingNameSet(parent);
    const final = uniqueName(safe, (n) => taken.has(n.toLowerCase()));
    const node = this.tree.createNode(parent, index);
    node.data.set("name", final);
    node.data.set("kind", "markdown");
    node.data.set("documentId", documentId);
    this.doc.commit();
    return node.id;
  }

  /** Add a binary file node. Auto-suffixes on a case-insensitive name clash. */
  addBinaryFile(
    parent: TreeID | undefined,
    name: string,
    metadata: BinaryFileMetadata,
    index?: number,
  ): TreeID;
  addBinaryFile(
    parent: TreeID | undefined,
    name: string,
    sha256: string,
    index?: number,
  ): TreeID;
  addBinaryFile(
    parent: TreeID | undefined,
    name: string,
    metadata: string | BinaryFileMetadata,
    index?: number,
  ): TreeID {
    const details = typeof metadata === "string" ? { sha256: metadata } : metadata;
    const safe = sanitizeName(name);
    if (!safe) throw new Error(`Invalid name: ${name}`);
    const taken = this.siblingNameSet(parent);
    const final = uniqueName(safe, (n) => taken.has(n.toLowerCase()));
    const node = this.tree.createNode(parent, index);
    node.data.set("name", final);
    node.data.set("kind", "binary");
    node.data.set("sha256", details.sha256);
    if (details.size !== undefined) node.data.set("size", details.size);
    if (details.mime !== undefined) node.data.set("mime", details.mime);
    this.doc.commit();
    return node.id;
  }

  /** Update binary metadata as a real tree CRDT edit. */
  updateBinaryMetadata(treeId: TreeID, metadata: Partial<BinaryFileMetadata>): void {
    const node = this.tree.getNodeByID(treeId);
    if (!node || node.isDeleted() || node.data.get("kind") !== "binary") {
      throw new Error(`Binary file not found: ${treeId}`);
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined) node.data.set(key, value);
    }
    this.doc.commit();
  }

  /**
   * Rename a node. Resolves a case-insensitive filename conflict with a
   * sibling by auto-suffixing (" 2", " 3", ...) rather than rejecting the
   * rename outright.
   */
  rename(treeId: TreeID, newName: string): void {
    const safe = sanitizeName(newName);
    if (!safe) throw new Error(`Invalid name: ${newName}`);
    const node = this.tree.getNodeByID(treeId);
    if (!node || node.isDeleted()) throw new Error(`Node not found: ${treeId}`);
    const parent = node.parent();
    const currentName = (node.data.get("name") as string) || "";
    if (safe.toLowerCase() === currentName.toLowerCase()) {
      if (safe !== currentName) node.data.set("name", safe);
      this.doc.commit();
      return;
    }
    const taken = this.siblingNameSet(parent?.id, treeId);
    const final = uniqueName(safe, (n) => taken.has(n.toLowerCase()), currentName);
    node.data.set("name", final);
    this.doc.commit();
  }

  /**
   * Force `treeId` to re-uniquify its name against its *current* siblings,
   * even when the name hasn't changed — used to break a post-merge
   * same-name collision. `rename()`'s normal same-name-only-case-differs
   * shortcut (above) would otherwise skip the uniqueName check entirely,
   * since as far as a single `rename()` call is concerned nothing is
   * "changing". Returns the new name, or null if there was no collision
   * to break.
   */
  private forceUniquify(treeId: TreeID): string | null {
    const node = this.tree.getNodeByID(treeId);
    if (!node || node.isDeleted()) return null;
    const parent = node.parent();
    const currentName = (node.data.get("name") as string) || "";
    const taken = this.siblingNameSet(parent?.id, treeId);
    if (!taken.has(currentName.toLowerCase())) return null;
    const final = uniqueName(currentName, (n) => taken.has(n.toLowerCase()), currentName);
    if (final === currentName) return null;
    node.data.set("name", final);
    this.doc.commit();
    return final;
  }

  /**
   * Deterministically resolve every post-merge same-name-sibling collision
   * in the tree. Two peers, offline, each independently creating a node
   * with the same name in the same folder before ever syncing produces
   * two nodes that legitimately carry the identical stored `name` once
   * merged — nothing in the tree CRDT rejects that (it's two unrelated
   * creates, not one field with last-writer-wins).
   *
   * This is a *real* CRDT tree edit (unlike computing a name only at
   * materialize time): the result propagates through normal tree sync to
   * every device, so a colliding document's on-disk file never has to be
   * silently overwritten by a later save that happened to compute a
   * different "winner" for the same plain name.
   *
   * For each colliding group (same parent, same case-insensitive name),
   * the member whose *stable key* sorts lexicographically smallest keeps
   * the plain name; every other member gets force-uniquified (" 2",
   * " 3", ... — the same suffix convention create()/rename() use). The
   * stable key is the node's own content-independent identity —
   * documentId for a markdown node, sha256 for a binary, the treeId
   * itself for a directory (nothing else to key on) — never anything
   * that depends on arrival order or materialize timing, so every replica
   * that runs this against the same merged tree computes the exact same
   * renames with no further coordination.
   *
   * Returns the treeIds that were renamed (empty if there were no
   * collisions). Idempotent: running it again after all collisions are
   * resolved is a no-op.
   */
  resolveNameCollisions(): TreeID[] {
    type Entry = { treeId: TreeID; key: string };
    const groups = new Map<string, Entry[]>();

    const visit = (
      nodes: ReturnType<LoroTree["roots"]>,
      parentKey: string,
    ): void => {
      for (const node of nodes) {
        if (node.isDeleted()) continue;
        const name = ((node.data.get("name") as string) || "").toLowerCase();
        const kind = node.data.get("kind") as string | undefined;
        const stableKey =
          kind === "markdown"
            ? ((node.data.get("documentId") as string) ?? String(node.id))
            : kind === "binary"
              ? ((node.data.get("sha256") as string) ?? String(node.id))
              : String(node.id);
        const groupKey = `${parentKey}\u0000${name}`;
        const arr = groups.get(groupKey) ?? [];
        arr.push({ treeId: node.id, key: stableKey });
        groups.set(groupKey, arr);
        visit(node.children() ?? [], String(node.id));
      }
    };
    visit(this.tree.roots(), "\u0000root");

    const renamed: TreeID[] = [];
    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      const sorted = [...group].sort((a, b) => a.key.localeCompare(b.key));
      // sorted[0] (smallest key) keeps its plain name; every other member
      // in the group is force-uniquified against the (now-updated) taken
      // set, one at a time, so a three-way collision gets " 2", " 3", ...
      // rather than everyone independently landing on " 2".
      for (const loser of sorted.slice(1)) {
        if (this.forceUniquify(loser.treeId) !== null) renamed.push(loser.treeId);
      }
    }
    return renamed;
  }

  /**
   * Move a node to a new parent (optionally at `index`). If the node's
   * current name collides (case-insensitively) with a sibling already at
   * the destination, it is auto-suffixed the same way create/rename are —
   * a drag-and-drop move should never silently fail or overwrite.
   */
  move(target: TreeID, newParent: TreeID | undefined, index?: number): void {
    const node = this.tree.getNodeByID(target);
    if (!node || node.isDeleted()) throw new Error(`Node not found: ${target}`);
    const currentName = (node.data.get("name") as string) || "";
    const taken = this.siblingNameSet(newParent, target);
    if (taken.has(currentName.toLowerCase())) {
      const final = uniqueName(currentName, (n) => taken.has(n.toLowerCase()), currentName);
      node.data.set("name", final);
    }
    this.tree.move(target, newParent, index);
    this.doc.commit();
  }

  /** Delete a node. */
  delete(target: TreeID): void {
    this.tree.delete(target);
    this.doc.commit();
  }

  /** Get node by id. */
  getNode(treeId: TreeID): VaultTreeNode | undefined {
    const node = this.tree.getNodeByID(treeId);
    if (!node || node.isDeleted()) return undefined;
    return nodeToValue(node);
  }

  /** Get all nodes as flat list. */
  allNodes(): VaultTreeNode[] {
    return this.tree.nodes()
      .filter((n) => !n.isDeleted())
      .map(nodeToValue);
  }

  /** All active document IDs from the tree (§6 source of truth). */
  documentIds(): string[] {
    return this.allNodes()
      .filter((n) => n.kind === "markdown" && n.documentId)
      .map((n) => n.documentId!);
  }

  /** Get root nodes. */
  roots(): VaultTreeNode[] {
    return this.tree.roots().map(nodeToValue);
  }

  /** Find node by document ID. */
  findByDocumentId(documentId: string): VaultTreeNode | undefined {
    return this.allNodes().find((n) => n.documentId === documentId);
  }

  /** Find nodes by name in the tree. */
  findByName(name: string): VaultTreeNode[] {
    return this.allNodes().filter((n) => n.name === name);
  }

  /** Get children of a node. */
  children(treeId: TreeID): VaultTreeNode[] {
    const node = this.tree.getNodeByID(treeId);
    if (!node) return [];
    return (node.children() ?? []).filter((c) => !c.isDeleted()).map(nodeToValue);
  }

  /** Resolve a path to a tree node id. Returns undefined if not found. */
  resolvePath(pathParts: string[]): TreeID | undefined {
    let current = this.tree.roots();
    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i];
      const found = current.find(
        (n) => !n.isDeleted() && (n.data.get("name") as string) === part,
      );
      if (!found) return undefined;
      if (i === pathParts.length - 1) return found.id;
      current = (found.children() ?? []).filter((c) => !c.isDeleted());
    }
    return undefined;
  }
}

function nodeToValue(node: ReturnType<LoroTree["getNodeByID"]> & {}): VaultTreeNode {
  const data = node.data as unknown as LoroMap;
  return {
    treeId: node.id,
    name: (data.get("name") as string) || "",
    kind: (data.get("kind") as NodeKind) || "binary",
    documentId: (data.get("documentId") as string) || undefined,
    sha256: (data.get("sha256") as string) || undefined,
    size: typeof data.get("size") === "number" ? (data.get("size") as number) : undefined,
    mime: (data.get("mime") as string) || undefined,
  };
}
