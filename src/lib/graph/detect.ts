import { parseFlowchart, serializeFlowchart, type FlowchartGraph } from "@/lib/graph/mermaid";

/**
 * A graph document is stored as an ordinary Markdown document whose body
 * (after any YAML frontmatter) is essentially one ```mermaid fenced code
 * block containing a `flowchart TD` we can parse. Detection is content-only
 * — no separate tree node kind — so a document opens as a graph purely
 * because of what's in it (SPEC §37: "a graph is a single item in the
 * vault, like a note").
 */

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const FENCE_RE = /^```mermaid\r?\n([\s\S]*?)\r?\n?```\s*$/;

/** Strip a leading `---\n...\n---` YAML frontmatter block, if present. */
function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_RE, "");
}

/**
 * Returns the parsed graph if `markdown` is a graph document, or `null` if
 * it should open in the plain text editor instead (not shaped like a
 * single mermaid block, or the block doesn't parse as a supported
 * flowchart).
 */
export function detectGraphDocument(markdown: string): FlowchartGraph | null {
  const body = stripFrontmatter(markdown).trim();
  if (body.length === 0) return null;
  const match = FENCE_RE.exec(body);
  if (!match) return null;
  return parseFlowchart(match[1] ?? "");
}

/** Build the full document body (fenced mermaid block) for a graph. */
export function buildGraphMarkdown(graph: FlowchartGraph): string {
  return "```mermaid\n" + serializeFlowchart(graph) + "\n```\n";
}

/** The empty-graph document body, used when creating a new graph note. */
export function emptyGraphMarkdown(): string {
  return buildGraphMarkdown({ nodes: [], edges: [] });
}
