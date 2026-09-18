import { describe, it, expect } from "vitest";
import { parseFlowchart, serializeFlowchart, type FlowchartGraph } from "@/lib/graph/mermaid";

describe("parseFlowchart / serializeFlowchart", () => {
  it("round-trips a simple graph", () => {
    const src = [
      "flowchart TD",
      '    a["Alpha"]',
      '    b["Beta"]',
      "    a --> b",
    ].join("\n");
    const graph = parseFlowchart(src);
    expect(graph).toEqual({
      nodes: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      edges: [{ source: "a", target: "b" }],
    });
    expect(serializeFlowchart(graph!)).toBe(src);
  });

  it("round-trips labels with spaces and escaped quotes", () => {
    const graph: FlowchartGraph = {
      nodes: [
        { id: "a", label: 'Has "quotes" and spaces' },
        { id: "b", label: "Simple" },
      ],
      edges: [],
    };
    const out = serializeFlowchart(graph);
    expect(out).toContain('a["Has \\"quotes\\" and spaces"]');
    expect(parseFlowchart(out)).toEqual(graph);
  });

  it("round-trips labelled edges", () => {
    const src = [
      "flowchart TD",
      '    a["A"]',
      '    b["B"]',
      "    a -- yes --> b",
    ].join("\n");
    const graph = parseFlowchart(src);
    expect(graph!.edges).toEqual([{ source: "a", target: "b", label: "yes" }]);
    expect(serializeFlowchart(graph!)).toBe(src);
  });

  it("parses an empty graph (just the header)", () => {
    const graph = parseFlowchart("flowchart TD");
    expect(graph).toEqual({ nodes: [], edges: [] });
    expect(serializeFlowchart(graph!)).toBe("flowchart TD");
  });

  it("parses the alternate -->|label| edge syntax", () => {
    const graph = parseFlowchart(["flowchart TD", "a --> |maybe| b"].join("\n"));
    expect(graph!.edges).toEqual([{ source: "a", target: "b", label: "maybe" }]);
  });

  it("implicitly creates nodes mentioned only in edges", () => {
    const graph = parseFlowchart(["flowchart TD", "a --> b"].join("\n"));
    expect(graph!.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(graph!.nodes.find((n) => n.id === "a")!.label).toBe("a");
  });

  it("returns null for a missing/wrong header", () => {
    expect(parseFlowchart('a["A"]')).toBeNull();
    expect(parseFlowchart("flowchart LR\na-->b")).toBeNull();
  });

  it("returns null for unparseable/unsupported syntax rather than guessing", () => {
    const src = ["flowchart TD", "subgraph cluster", "a --> b", "end"].join("\n");
    expect(parseFlowchart(src)).toBeNull();
  });

  it("rejects invalid node ids on serialize", () => {
    expect(() =>
      serializeFlowchart({ nodes: [{ id: "has space", label: "x" }], edges: [] }),
    ).toThrow();
  });
});
