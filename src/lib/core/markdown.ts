import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { visit } from "unist-util-visit";
import type { Root, Heading, Link, Image } from "mdast";
import { extractIdFromMarkdown } from "@/lib/core/doc-id";
import type { ParsedDocument } from "@/lib/core/types";

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_\/-]+)/gu;

export function parseMarkdown(
  markdown: string,
  fallbackPath: string,
): ParsedDocument {
  const doc = {
    id: extractIdFromMarkdown(markdown) ?? fallbackPath,
    title: "",
    headings: [] as string[],
    wikilinks: [] as string[],
    links: [] as string[],
    tags: [] as string[],
    aliases: [] as string[],
    frontmatter: {} as Record<string, unknown>,
    body: markdown,
  };

  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter)
    .parse(markdown) as Root;

  visit(tree, (node) => {
    if (node.type === "yaml") {
      const data = parseYamlFrontmatter(node.value as string);
      Object.assign(doc.frontmatter, data);
      const rawTags = data.tags;
      if (Array.isArray(rawTags)) {
        doc.tags.push(...rawTags.filter((t): t is string => typeof t === "string"));
      } else if (typeof rawTags === "string") {
        doc.tags.push(rawTags);
      }
      const rawAliases = data.aliases ?? data.alias;
      if (Array.isArray(rawAliases)) {
        doc.aliases.push(
          ...rawAliases.filter((a): a is string => typeof a === "string"),
        );
      } else if (typeof rawAliases === "string") {
        doc.aliases.push(rawAliases);
      }
    }
    if (node.type === "heading" && (node as Heading).depth === 1) {
      const text = headingToText(node as Heading);
      if (!doc.title && text) doc.title = text;
    }
    if (node.type === "link") {
      const url = (node as Link).url;
      if (url && !url.startsWith("#")) {
        doc.links.push(decodeWikiTarget(url));
      }
    }
    if (node.type === "image") {
      const url = (node as Image).url;
      if (url && !/^(https?|data):/i.test(url)) {
        doc.links.push(url);
      }
    }
    if (node.type === "text") {
      const text = node.value as string;
      const wl = text.matchAll(WIKILINK_RE);
      for (const m of wl) {
        doc.wikilinks.push(m[1]!.trim());
      }
      const tags = text.matchAll(TAG_RE);
      for (const m of tags) {
        const t = m[1]!.trim();
        if (t.length > 1 && !/^[0-9]+$/.test(t) && !doc.tags.includes(t)) {
          doc.tags.push(t);
        }
      }
    }
    if (node.type === "heading" && (node as Heading).depth > 1) {
      const text = headingToText(node as Heading);
      if (text) doc.headings.push(text);
    }
  });

  const firstHeadingAsTitle = tree.children.find(
    (n): n is Heading => n.type === "heading",
  );
  if (!doc.title && firstHeadingAsTitle) {
    doc.title = headingToText(firstHeadingAsTitle);
  }
  doc.title = doc.title || fallbackPath.split("/").pop()!.replace(/\.md$/i, "");

  return doc;
}

function headingToText(node: Heading): string {
  return collectNodeText(node);
}

function collectNodeText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const n = node as { children?: unknown[]; value?: unknown };
  if (typeof n.value === "string") return n.value;
  let out = "";
  for (const child of n.children ?? []) {
    if (typeof child === "string") out += child;
    else if (child && typeof child === "object") out += collectNodeText(child);
  }
  return out;
}

function decodeWikiTarget(t: string): string {
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

export function parseYamlFrontmatter(source: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const line of source.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trimEnd());
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.trim();
    if (!value || value === "|" || value === ">") continue;
    data[key] = parseYamlScalar(value);
  }
  return data;
}

function parseYamlScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const quote = s.match(/^['"](.+)['"]$/);
        return quote ? quote[1]! : s;
      });
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value.replace(/^'(.+)'$/, "$1");
}