import { LoroDoc, LoroTree, LoroMap, type OpId, type TreeID } from "loro-crdt";
import type { NodeKind, TreeNodeMeta } from "@/lib/core/types";
import { sanitizeName, normalizeName, uniqueName } from "@/lib/core/paths";

export const TREE_KEY = "vault-tree";

export interface VaultTreeNode {
  treeId: TreeID;
  name: string;
  kind: NodeKind;
  documentId?: string;
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

  /** Add a directory node. */
  addDirectory(
    parent: TreeID | undefined,
    name: string,
    index?: number,
  ): TreeID {
    const safe = sanitizeName(name);
    if (!safe) throw new Error(`Invalid directory name: ${name}`);
    const node = this.tree.createNode(parent, index);
    node.data.set("name", safe);
    node.data.set("kind", "directory");
    this.doc.commit();
    return node.id;
  }

  /** Add a Markdown document node. Returns the new treeId. */
  addMarkdownDocument(
    parent: TreeID | undefined,
    name: string,
    documentId: string,
    index?: number,
  ): TreeID {
    const safe = sanitizeName(name);
    if (!safe) throw new Error(`Invalid name: ${name}`);
    if (!safe.endsWith(".md")) throw new Error(`Markdown files must end with .md`);
    const node = this.tree.createNode(parent, index);
    node.data.set("name", safe);
    node.data.set("kind", "markdown");
    node.data.set("documentId", documentId);
    this.doc.commit();
    return node.id;
  }

  /** Add a binary file node. */
  addBinaryFile(
    parent: TreeID | undefined,
    name: string,
    sha256: string,
    index?: number,
  ): TreeID {
    const safe = sanitizeName(name);
    if (!safe) throw new Error(`Invalid name: ${name}`);
    const node = this.tree.createNode(parent, index);
    node.data.set("name", safe);
    node.data.set("kind", "binary");
    node.data.set("sha256", sha256);
    this.doc.commit();
    return node.id;
  }

  /** Rename a node. Resolves filename conflicts. */
  rename(treeId: TreeID, newName: string): void {
    const safe = sanitizeName(newName);
    if (!safe) throw new Error(`Invalid name: ${newName}`);
    const node = this.tree.getNodeByID(treeId);
    if (!node || node.isDeleted()) throw new Error(`Node not found: ${treeId}`);
    const parent = node.parent();
    const siblings = parent ? parent.children() ?? [] : this.tree.roots();
    const currentName = (node.data.get("name") as string) || "";
    if (safe === currentName) return;
    const taken = new Set(
      siblings
        .filter((s) => s.id !== treeId)
        .map((s) => s.data.get("name") as string),
    );
    const final = uniqueName(safe, (n) => taken.has(n), currentName);
    node.data.set("name", final);
    this.doc.commit();
  }

  /** Move a node to a new parent. */
  move(target: TreeID, newParent: TreeID | undefined, index?: number): void {
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
  };
}