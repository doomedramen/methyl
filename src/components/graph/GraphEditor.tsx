"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeMouseHandler,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, Maximize2, Workflow } from "lucide-react";
import type { VaultEngine } from "@/lib/vault/engine";
import { detectGraphDocument, buildGraphMarkdown } from "@/lib/graph/detect";
import type { FlowchartGraph } from "@/lib/graph/mermaid";
import { readGraphLayout, writeGraphLayout } from "@/lib/graph/layout-store";
import { Button } from "@/components/ui/button";

interface NodeData extends Record<string, unknown> {
  label: string;
  readOnly: boolean;
  onLabelChange: (id: string, label: string) => void;
}

type GraphFlowNode = Node<NodeData>;

/** Simple deterministic grid fallback for nodes with no stored position —
 * so a graph opened somewhere that's never seen `graph-layout.json` (a
 * fresh clone, a peer that synced only the `.md`) still renders sensibly. */
function autoPosition(index: number): { x: number; y: number } {
  const columns = 4;
  const col = index % columns;
  const row = Math.floor(index / columns);
  return { x: col * 220, y: row * 120 };
}

const H_GAP = 240;
const V_GAP = 140;

/**
 * Dependency-free layered (top-down) layout for the graph: Kahn's algorithm
 * assigns each node the earliest layer consistent with its incoming edges,
 * then nodes are spread horizontally within their layer and centered against
 * the widest layer. Cycles and isolated nodes fall back to their own rows, so
 * the button always produces a readable spread — no graph database platform
 * strip, no `dagre` dependency.
 */
function computeLayeredPositions(
  nodes: GraphFlowNode[],
  edges: Edge[],
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  if (nodes.length === 0) return out;

  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) {
    outgoing.set(n.id, []);
    indegree.set(n.id, 0);
  }
  for (const e of edges) {
    if (!outgoing.has(e.source) || !indegree.has(e.target)) continue;
    outgoing.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }

  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if ((indegree.get(n.id) ?? 0) === 0) {
      layer.set(n.id, 0);
      queue.push(n.id);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const l = layer.get(id) ?? 0;
    for (const target of outgoing.get(id)!) {
      const pushed = l + 1;
      if (pushed > (layer.get(target) ?? -1)) layer.set(target, pushed);
      const remaining = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, remaining);
      if (remaining <= 0) queue.push(target);
    }
  }
  // Nodes Kahn never reached (cycles, self-loops) get their own rows.
  let extraRow = 0;
  for (const n of nodes) {
    if (!layer.has(n.id)) {
      layer.set(n.id, extraRow + 1);
      extraRow++;
    }
  }

  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    const row = byLayer.get(l) ?? [];
    row.push(n.id);
    byLayer.set(l, row);
  }
  const widest = Math.max(...[...byLayer.values()].map((row) => row.length));
  for (const [l, row] of byLayer) {
    const startX = ((widest - row.length) * H_GAP) / 2;
    row.forEach((id, i) => {
      out[id] = { x: startX + i * H_GAP, y: l * V_GAP };
    });
  }
  return out;
}

function GraphLabelNode({ id, data, selected }: NodeProps<GraphFlowNode>) {
  // Uncontrolled-ish: seeded from data.label once, then owns its own typing
  // buffer — commits on blur via onLabelChange. External relabels of an
  // already-mounted node (there are none in this editor today; every label
  // edit round-trips through this same component) would not be reflected
  // mid-edit, which is an acceptable tradeoff for avoiding a render-cycle
  // sync effect.
  const [value, setValue] = useState(data.label);

  return (
    <div
      className={`min-w-[140px] max-w-[260px] rounded-md border bg-card px-3 py-2 text-sm shadow-sm ${
        selected ? "border-primary ring-1 ring-primary" : "border-border"
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <textarea
        value={value}
        readOnly={data.readOnly}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => data.onLabelChange(id, value)}
        rows={Math.max(1, value.split("\n").length)}
        className="w-full resize-none border-0 bg-transparent p-0 text-sm outline-none focus-visible:outline-none"
        placeholder="Untitled node"
      />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { graphNode: GraphLabelNode };

function graphToFlow(
  graph: FlowchartGraph,
  positions: Record<string, { x: number; y: number }>,
  readOnly: boolean,
  onLabelChange: (id: string, label: string) => void,
): { nodes: GraphFlowNode[]; edges: Edge[] } {
  const nodes: GraphFlowNode[] = graph.nodes.map((n, i) => ({
    id: n.id,
    type: "graphNode",
    position: positions[n.id] ?? autoPosition(i),
    data: { label: n.label, readOnly, onLabelChange },
  }));
  const edges: Edge[] = graph.edges.map((e) => ({
    id: `${e.source}->${e.target}:${e.label ?? ""}`,
    source: e.source,
    target: e.target,
    label: e.label,
  }));
  return { nodes, edges };
}

function flowToGraph(nodes: GraphFlowNode[], edges: Edge[]): FlowchartGraph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, label: n.data.label })),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      label: typeof e.label === "string" ? e.label : undefined,
    })),
  };
}

function newNodeId(): string {
  return `n-${crypto.randomUUID()}`;
}

interface GraphEditorProps {
  engine: VaultEngine;
  documentId: string;
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onPersisted?: () => void;
  onSaveError?: () => void;
  /** Incrementing counter; a new value asks for an immediate persist. */
  saveRequest?: number;
}

function GraphEditorInner({
  engine,
  documentId,
  readOnly = false,
  onDirtyChange,
  onPersisted,
  onSaveError,
  saveRequest = 0,
}: GraphEditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Which documentId the current `nodes`/`edges` were loaded for — `ready`
  // is derived from this rather than a separate boolean, so there's no
  // synchronous setState-at-effect-start to reset it on documentId change.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const ready = loadedFor === documentId;
  const { screenToFlowPosition, fitView } = useReactFlow();
  const rf = useReactFlow();

  const wrapperRef = useRef<HTMLDivElement>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = useRef(false);

  // Kept current via an effect (never mutated during render) so callbacks
  // built once per node/edge — e.g. onLabelChange, closed over at node
  // creation — always persist the latest sibling array.
  const edgesRef = useRef<Edge[]>(edges);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);
  const nodesRef = useRef<GraphFlowNode[]>(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const persistNow = useCallback(
    async (nextNodes: GraphFlowNode[], nextEdges: Edge[]) => {
      if (disposed.current || readOnly) return;
      const doc = engine.getDocument(documentId);
      if (!doc) return;
      try {
        // Dynamic import: keeps loro-crdt's WASM out of this component's
        // static module graph (NoteEditor.tsx does the same) — GraphEditor
        // is statically imported by VaultApp, which is prerendered.
        const { CONTENT_KEY } = await import("@/lib/core/document");
        const markdown = buildGraphMarkdown(flowToGraph(nextNodes, nextEdges));
        const text = doc.getText(CONTENT_KEY);
        const cur = text.toString();
        if (cur !== markdown) {
          text.splice(0, cur.length, markdown);
          doc.doc.commit();
        }
        await engine.persistDocumentIncremental(documentId);
        if (!disposed.current) onPersisted?.();
      } catch (err) {
        console.error("[graph] persist failed", err);
        if (!disposed.current) onSaveError?.();
      }
    },
    [engine, documentId, readOnly, onPersisted, onSaveError],
  );

  const schedulePersist = useCallback(
    (nextNodes: GraphFlowNode[], nextEdges: Edge[]) => {
      onDirtyChange?.(true);
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        void persistNow(nextNodes, nextEdges);
      }, 400);
    },
    [onDirtyChange, persistNow],
  );

  const onLabelChange = useCallback(
    (id: string, label: string) => {
      const next = nodesRef.current.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, label } } : n,
      );
      setNodes(next);
      schedulePersist(next, edgesRef.current);
    },
    [setNodes, schedulePersist],
  );

  const scheduleLayoutSave = useCallback(
    (nextNodes: GraphFlowNode[]) => {
      if (readOnly) return;
      if (layoutTimer.current) clearTimeout(layoutTimer.current);
      layoutTimer.current = setTimeout(() => {
        const layoutNodes: Record<string, { x: number; y: number }> = {};
        for (const n of nextNodes) layoutNodes[n.id] = { x: n.position.x, y: n.position.y };
        void writeGraphLayout(engine.docStore, documentId, { nodes: layoutNodes });
      }, 400);
    },
    [engine, documentId, readOnly],
  );

  // Load the document + stored layout on mount / documentId change.
  useEffect(() => {
    disposed.current = false;
    let cancelled = false;
    (async () => {
      const doc = engine.getDocument(documentId);
      const markdown = doc ? doc.getMarkdown() : "";
      const graph = detectGraphDocument(markdown) ?? { nodes: [], edges: [] };
      const layout = await readGraphLayout(engine.docStore, documentId);
      if (cancelled) return;
      const positions = layout?.nodes ?? {};
      const { nodes: flowNodes, edges: flowEdges } = graphToFlow(
        graph,
        positions,
        readOnly,
        onLabelChange,
      );
      setNodes(flowNodes);
      setEdges(flowEdges);
      setLoadedFor(documentId);
      requestAnimationFrame(() => fitView({ padding: 0.2 }));
    })();
    return () => {
      cancelled = true;
      disposed.current = true;
      if (persistTimer.current) clearTimeout(persistTimer.current);
      if (layoutTimer.current) clearTimeout(layoutTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, documentId, readOnly]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      const next = addEdge(connection, edgesRef.current);
      setEdges(next);
      schedulePersist(nodesRef.current, next);
    },
    [readOnly, setEdges, schedulePersist],
  );

  const addNode = useCallback(
    (position?: { x: number; y: number }) => {
      if (readOnly) return;
      const id = newNodeId();
      // Default placement is the center of the current viewport (the pane
      // double-click already passes an exact flow position) so the node
      // never lands off-screen when the graph was panned elsewhere. A small
      // cascade keeps successive button-adds from stacking exactly on top of
      // each other.
      let base = position;
      if (!base) {
        const el = wrapperRef.current;
        if (el) {
          // getBoundingClientRect() returns viewport-relative coords, which
          // is exactly what screenToFlowPosition expects.
          const rect = el.getBoundingClientRect();
          base = screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
        } else {
          base = autoPosition(nodesRef.current.length);
        }
      }
      const count = nodesRef.current.length;
      const pos = { x: base.x + (count % 5) * 20, y: base.y + (count % 5) * 20 };
      const next: GraphFlowNode[] = [
        ...nodesRef.current,
        {
          id,
          type: "graphNode",
          position: pos,
          // Give it a name: an empty label serialises as `id[""]`, which
          // reads as an empty box in any other Mermaid renderer.
          data: { label: "Node", readOnly, onLabelChange },
        },
      ];
      setNodes(next);
      schedulePersist(next, edgesRef.current);
      scheduleLayoutSave(next);
    },
    [
      readOnly,
      setNodes,
      onLabelChange,
      schedulePersist,
      scheduleLayoutSave,
      screenToFlowPosition,
    ],
  );

  const autoArrange = useCallback(() => {
    if (readOnly) return;
    const positions = computeLayeredPositions(nodesRef.current, edgesRef.current);
    const next = nodesRef.current.map((n) => ({ ...n, position: positions[n.id] }));
    setNodes(next);
    // Layout only — node positions never touch the Markdown, so no persist.
    scheduleLayoutSave(next);
    requestAnimationFrame(() => fitView({ padding: 0.2 }));
  }, [readOnly, setNodes, scheduleLayoutSave, fitView]);

  const onPaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNode(pos);
    },
    [readOnly, screenToFlowPosition, addNode],
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      const structural = changes.some((c) => c.type === "remove");
      const positional = changes.some((c) => c.type === "position" && c.dragging === false);
      if (structural) {
        // Compute post-change arrays on next tick (state has just been queued).
        setTimeout(() => schedulePersist(nodesRef.current, edgesRef.current), 0);
      }
      if (positional) {
        setTimeout(() => scheduleLayoutSave(nodesRef.current), 0);
      }
    },
    [onNodesChange, schedulePersist, scheduleLayoutSave],
  );

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      const structural = changes.some((c) => c.type === "remove");
      if (structural) {
        setTimeout(() => schedulePersist(nodesRef.current, edgesRef.current), 0);
      }
    },
    [onEdgesChange, schedulePersist],
  );

  const onMoveEnd = useCallback(() => {
    if (readOnly) return;
    const vp = rf.getViewport();
    if (layoutTimer.current) clearTimeout(layoutTimer.current);
    layoutTimer.current = setTimeout(() => {
      void (async () => {
        const layout = (await readGraphLayout(engine.docStore, documentId)) ?? { nodes: {} };
        await writeGraphLayout(engine.docStore, documentId, { ...layout, viewport: vp });
      })();
    }, 400);
  }, [engine, documentId, readOnly, rf]);

  // Reply to the app-level "save now" request (Cmd/Ctrl+S in VaultApp).
  useEffect(() => {
    if (!saveRequest || readOnly) return;
    void persistNow(nodesRef.current, edgesRef.current);
  }, [saveRequest, readOnly, persistNow]);

  const onNodeDoubleClick: NodeMouseHandler = useCallback((e) => {
    e.stopPropagation();
  }, []);

  const canEdit = !readOnly;

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <ReactFlow<GraphFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onDoubleClick={onPaneDoubleClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onMoveEnd={onMoveEnd}
        nodeTypes={nodeTypes}
        nodesDraggable={canEdit}
        nodesConnectable={canEdit}
        elementsSelectable
        deleteKeyCode={canEdit ? ["Backspace", "Delete"] : []}
        zoomOnDoubleClick={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="absolute right-3 top-3 z-10 flex gap-2">
        <Button
          variant="outline"
          size="icon"
          disabled={!canEdit}
          aria-label="Add node"
          onClick={() => addNode()}
        >
          <Plus />
        </Button>
        <Button
          variant="outline"
          size="icon"
          disabled={!canEdit}
          aria-label="Auto arrange"
          onClick={autoArrange}
        >
          <Workflow />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Fit view"
          onClick={() => fitView({ padding: 0.2 })}
        >
          <Maximize2 />
        </Button>
      </div>
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-sm text-muted-foreground">
          Loading graph…
        </div>
      )}
    </div>
  );
}

export function GraphEditor(props: GraphEditorProps) {
  return (
    <ReactFlowProvider>
      <GraphEditorInner {...props} />
    </ReactFlowProvider>
  );
}
