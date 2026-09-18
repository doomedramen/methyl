/**
 * Pure, dependency-free Mermaid `flowchart TD` parser/serializer for graph
 * documents (SPEC §37 — a graph is stored as an ordinary Markdown document
 * whose body is a single ```mermaid fenced block).
 *
 * Supported dialect (deliberately small — this is the subset the visual
 * editor itself can produce, not a general Mermaid parser):
 *
 *   flowchart TD
 *       id1["Quoted label, can have spaces and \"escaped\" quotes"]
 *       id2[Unquoted label]
 *       id3
 *       id1 --> id2
 *       id1 -- edge label --> id3
 *
 * - Node ids: `[A-Za-z0-9_-]+`.
 * - A node line with no bracketed label at all is a bare mention (its own
 *   id is used as the label) — this also covers a node that only ever
 *   appears as an edge endpoint.
 * - Edge labels use the `-- text -->` form. `-->|text|` is also accepted
 *   when parsing (common alternate Mermaid syntax) for robustness, but is
 *   never produced by `serializeFlowchart`.
 *
 * Anything outside this subset makes `parseFlowchart` return `null` — the
 * caller (detect.ts) falls back to the plain text editor rather than risk
 * mangling content it doesn't understand.
 */

export interface GraphNode {
  id: string;
  label: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
}

export interface FlowchartGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

const HEADER_RE = /^flowchart\s+TD\s*$/i;
const QUOTED_NODE_RE = /^([A-Za-z0-9_-]+)\["((?:[^"\\]|\\.)*)"\]$/;
const UNQUOTED_NODE_RE = /^([A-Za-z0-9_-]+)\[(.+)\]$/;
const BARE_NODE_RE = /^([A-Za-z0-9_-]+)$/;
// id1 -- label --> id2   (label optional)
const LABELLED_EDGE_RE = /^([A-Za-z0-9_-]+)\s*--\s*(.*?)\s*-->\s*([A-Za-z0-9_-]+)$/;
// id1 --> id2
const PLAIN_EDGE_RE = /^([A-Za-z0-9_-]+)\s*-->\s*([A-Za-z0-9_-]+)$/;
// id1 -->|label| id2   (alternate Mermaid syntax, parse-only)
const PIPE_EDGE_RE = /^([A-Za-z0-9_-]+)\s*-->\s*\|(.*)\|\s*([A-Za-z0-9_-]+)$/;

function unescapeLabel(raw: string): string {
  return raw.replace(/\\(["\\])/g, "$1");
}

function escapeLabel(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Parse a `flowchart TD` block's body (the text between the ```mermaid
 * fences, NOT including the fences themselves). Returns `null` if any line
 * fails to match the supported subset, or the header is missing/wrong.
 */
export function parseFlowchart(source: string): FlowchartGraph | null {
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));

  if (lines.length === 0) return null;
  if (!HEADER_RE.test(lines[0]!)) return null;

  const nodes = new Map<string, string | undefined>();
  const edges: GraphEdge[] = [];

  const ensureNode = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, undefined);
  };

  for (const line of lines.slice(1)) {
    const quoted = QUOTED_NODE_RE.exec(line);
    if (quoted) {
      const [, id, label] = quoted;
      nodes.set(id!, unescapeLabel(label!));
      continue;
    }

    const pipeEdge = PIPE_EDGE_RE.exec(line);
    if (pipeEdge) {
      const [, source, label, target] = pipeEdge;
      ensureNode(source!);
      ensureNode(target!);
      edges.push({ source: source!, target: target!, label: label!.trim() || undefined });
      continue;
    }

    const labelledEdge = LABELLED_EDGE_RE.exec(line);
    if (labelledEdge) {
      const [, source, label, target] = labelledEdge;
      ensureNode(source!);
      ensureNode(target!);
      edges.push({ source: source!, target: target!, label: label ? label.trim() || undefined : undefined });
      continue;
    }

    const plainEdge = PLAIN_EDGE_RE.exec(line);
    if (plainEdge) {
      const [, source, target] = plainEdge;
      ensureNode(source!);
      ensureNode(target!);
      edges.push({ source: source!, target: target! });
      continue;
    }

    const unquoted = UNQUOTED_NODE_RE.exec(line);
    if (unquoted) {
      const [, id, label] = unquoted;
      nodes.set(id!, label!.trim());
      continue;
    }

    const bare = BARE_NODE_RE.exec(line);
    if (bare) {
      ensureNode(bare[1]!);
      continue;
    }

    // Unrecognized line — bail out rather than silently dropping content.
    return null;
  }

  const graphNodes: GraphNode[] = Array.from(nodes.entries()).map(([id, label]) => ({
    id,
    label: label ?? id,
  }));

  return { nodes: graphNodes, edges };
}

/**
 * Serialize a graph back to a `flowchart TD` body (no fences). Node labels
 * are always emitted quoted (handles spaces/quotes uniformly); edge labels
 * use the `-- text -->` form. Deterministic given the same input, so
 * re-serializing after a pure layout (position-only) change is a byte-for-byte
 * no-op.
 */
export function serializeFlowchart(graph: FlowchartGraph): string {
  const lines: string[] = ["flowchart TD"];
  for (const node of graph.nodes) {
    if (!ID_RE.test(node.id)) throw new Error(`Invalid node id: ${node.id}`);
    lines.push(`    ${node.id}["${escapeLabel(node.label)}"]`);
  }
  for (const edge of graph.edges) {
    if (!ID_RE.test(edge.source) || !ID_RE.test(edge.target)) {
      throw new Error(`Invalid edge endpoint: ${edge.source} -> ${edge.target}`);
    }
    if (edge.label && edge.label.trim().length > 0) {
      lines.push(`    ${edge.source} -- ${edge.label.trim()} --> ${edge.target}`);
    } else {
      lines.push(`    ${edge.source} --> ${edge.target}`);
    }
  }
  return lines.join("\n");
}
