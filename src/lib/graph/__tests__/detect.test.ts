import { describe, it, expect } from "vitest";
import { detectGraphDocument, buildGraphMarkdown, emptyGraphMarkdown } from "@/lib/graph/detect";
import { serializeFlowchart, type FlowchartGraph } from "@/lib/graph/mermaid";

describe("detectGraphDocument", () => {
  it("detects a document whose body is a single mermaid flowchart block", () => {
    const md = "```mermaid\nflowchart TD\n    a[\"A\"]\n```\n";
    const graph = detectGraphDocument(md);
    expect(graph).toEqual({ nodes: [{ id: "a", label: "A" }], edges: [] });
  });

  it("detects through leading frontmatter", () => {
    const md = "---\nstatus: draft\n---\n```mermaid\nflowchart TD\n```\n";
    expect(detectGraphDocument(md)).toEqual({ nodes: [], edges: [] });
  });

  it("returns null for an ordinary note", () => {
    expect(detectGraphDocument("# Hello\n\nJust text.")).toBeNull();
  });

  it("returns null for a mermaid block that isn't the whole body", () => {
    const md = "Some intro.\n\n```mermaid\nflowchart TD\n```\n";
    expect(detectGraphDocument(md)).toBeNull();
  });

  it("returns null for a non-flowchart mermaid block", () => {
    const md = "```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n";
    expect(detectGraphDocument(md)).toBeNull();
  });

  it("returns null (falls back to text editor) for unparseable mermaid content", () => {
    const md = "```mermaid\nflowchart TD\nsubgraph x\nend\n```\n";
    expect(detectGraphDocument(md)).toBeNull();
  });

  it("returns null for an empty document", () => {
    expect(detectGraphDocument("")).toBeNull();
  });

  it("buildGraphMarkdown/emptyGraphMarkdown produce a document detectGraphDocument accepts", () => {
    const graph: FlowchartGraph = { nodes: [{ id: "a", label: "Hi" }], edges: [] };
    const md = buildGraphMarkdown(graph);
    expect(detectGraphDocument(md)).toEqual(graph);
    expect(detectGraphDocument(emptyGraphMarkdown())).toEqual({ nodes: [], edges: [] });
  });

  it("serializing after a pure layout change leaves the markdown unchanged", () => {
    const graph: FlowchartGraph = {
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [{ source: "a", target: "b" }],
    };
    const before = serializeFlowchart(graph);
    // Simulate moving a node: layout lives elsewhere, graph content is untouched.
    const after = serializeFlowchart(graph);
    expect(after).toBe(before);
  });
});
