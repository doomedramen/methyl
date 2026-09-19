import type { TreeID } from "loro-crdt";
import type { VaultEngine } from "@/lib/vault/engine";
import type { VaultTreeNode } from "@/lib/vault/tree";

const MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  csv: "text/csv",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
};

export function attachmentMimeType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

export function isImageAttachment(name: string): boolean {
  return attachmentMimeType(name).startsWith("image/");
}

export function isPlayableAttachment(name: string): boolean {
  const mime = attachmentMimeType(name);
  return mime.startsWith("audio/") || mime.startsWith("video/");
}

function normalizeTarget(target: string): string {
  let value = target.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  value = value.replace(/^\.\//, "").replace(/^\//, "");
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function pathFromNode(engine: VaultEngine, node: VaultTreeNode): string | null {
  const parts: string[] = [];
  let current = engine.tree.tree.getNodeByID(node.treeId);
  while (current) {
    parts.unshift((current.data.get("name") as string) || "");
    current = current.parent() ?? undefined;
  }
  return parts.join("/") || null;
}

function resolveTargetParts(
  engine: VaultEngine,
  target: string,
  documentId?: string,
): string[] | undefined {
  const normalized = normalizeTarget(target);
  if (!normalized || /^(?:[a-z]+:|data:)/i.test(normalized)) return undefined;

  const directParts = normalized.split("/").filter(Boolean);
  if (engine.tree.resolvePath(directParts) !== undefined) return directParts;

  const note = documentId ? engine.tree.findByDocumentId(documentId) : undefined;
  const notePath = note ? pathFromNode(engine, note) : null;
  const parts = notePath ? notePath.split("/").slice(0, -1) : [];
  for (const part of directParts) {
    if (part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts;
}

/** Resolve an embed target against the CRDT tree, including basename links. */
export function findAttachmentNode(
  engine: VaultEngine,
  target: string,
  documentId?: string,
): VaultTreeNode | undefined {
  const normalized = normalizeTarget(target);
  const parts = resolveTargetParts(engine, target, documentId);
  if (!normalized || !parts) return undefined;
  const exact = engine.tree.resolvePath(parts);
  const exactNode = exact === undefined ? undefined : engine.tree.getNode(exact);
  if (exactNode?.kind === "binary") return exactNode;

  const candidates = engine.tree
    .allNodes()
    .filter((node) => node.kind === "binary" && node.name.toLowerCase() === parts.at(-1)?.toLowerCase());
  return candidates.length === 1 ? candidates[0] : undefined;
}

export class AttachmentPreviewCache {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | undefined>>();

  constructor(private readonly engine: VaultEngine) {}

  resolve(target: string, documentId?: string): string | undefined {
    const node = findAttachmentNode(this.engine, target, documentId);
    return node ? this.urls.get(String(node.treeId)) : undefined;
  }

  load(target: string, documentId?: string): Promise<string | undefined> {
    const node = findAttachmentNode(this.engine, target, documentId);
    if (!node) return Promise.resolve(undefined);
    const key = String(node.treeId);
    const existing = this.urls.get(key);
    if (existing) return Promise.resolve(existing);
    const pending = this.pending.get(key);
    if (pending) return pending;

    const request = this.engine.readAttachment(node.treeId).then((bytes) => {
      if (!bytes || typeof URL === "undefined" || typeof Blob === "undefined") return undefined;
      const url = URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: attachmentMimeType(node.name) }),
      );
      this.urls.set(key, url);
      return url;
    }).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pending.clear();
  }
}

export function attachmentEmbedTarget(path: string): string {
  return `![[${path}]]`;
}

export function attachmentDisplayName(path: string): string {
  const normalized = normalizeTarget(path);
  return normalized.split("/").pop() || normalized;
}

/** Return a portable, URL-encoded path from a note to a tracked attachment. */
export function relativeAttachmentPath(
  engine: VaultEngine,
  documentId: string,
  treeId: TreeID,
): string | undefined {
  const note = engine.tree.findByDocumentId(documentId);
  const asset = engine.tree.getNode(treeId);
  if (!note || !asset || asset.kind !== "binary") return undefined;
  const notePath = pathFromNode(engine, note);
  const assetPath = pathFromNode(engine, asset);
  if (!notePath || !assetPath) return undefined;
  const base = notePath.split("/").slice(0, -1);
  const target = assetPath.split("/");
  let common = 0;
  while (common < base.length && common < target.length && base[common] === target[common]) common++;
  return [
    ...Array.from({ length: base.length - common }, () => ".."),
    ...target.slice(common),
  ].map(encodePathSegment).join("/");
}

export function attachmentMarkdownLink(
  name: string,
  relativePath: string,
): string {
  const label = name.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
  return isImageAttachment(name)
    ? `![${label}](${relativePath})`
    : `[${label}](${relativePath})`;
}

export type { TreeID };
