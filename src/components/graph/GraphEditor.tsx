"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
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
import { Plus, Maximize2, Workflow, StickyNote, ListTodo, Spline, Trash2 } from "lucide-react";
import type { VaultEngine } from "@/lib/vault/engine";
import { detectGraphDocument, buildGraphMarkdown } from "@/lib/graph/detect";
import type { FlowchartGraph } from "@/lib/graph/mermaid";
import {
  readGraphLayout,
  writeGraphLayout,
  type GraphNodeMeta,
} from "@/lib/graph/layout-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

export type NodeKind = "graph" | "todo";

interface NodeData extends Record<string, unknown> {
  label: string;
  readOnly: boolean;
  kind: NodeKind;
  done?: boolean;
  onLabelChange: (id: string, label: string) => void;
  onToggleDone: (id: string, done: boolean) => void;
  onConvertType: (id: string, kind: NodeKind) => void;
  onDelete: (id: string) => void;
}

type GraphFlowNode = Node<NodeData>;

/** True once the viewport is at least `minWidth` wide; no SSR needed since
 * GraphEditor is client-only (lazy-chunked with `ssr: false`). */
function useMinWidth(minWidth: number): boolean {
  const [matches, setMatches] = useState(
    () => typeof window === "undefined" || window.matchMedia(`(min-width: ${minWidth}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [minWidth]);
  return matches;
}

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

  const card = (
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

  if (data.readOnly) return card;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={card} />
      <ContextMenuContent>
        <ContextMenuItem onClick={() => data.onConvertType(id, "todo")}>
          <ListTodo data-icon="inline-start" />
          Convert to to-do
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => data.onDelete(id)}>
          <Trash2 data-icon="inline-start" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TodoNode({ id, data, selected }: NodeProps<GraphFlowNode>) {
  const [value, setValue] = useState(data.label);
  const done = data.done === true;

  const card = (
    <div
      className={`min-w-[170px] max-w-[260px] rounded-md border bg-card px-3 py-2 text-sm shadow-sm ${
        selected ? "border-primary ring-1 ring-primary" : "border-border"
      } ${done ? "opacity-70" : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={done}
          disabled={data.readOnly}
          onChange={(e) => data.onToggleDone(id, e.target.checked)}
          aria-label="Mark done"
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--primary)]"
        />
        <textarea
          value={value}
          readOnly={data.readOnly}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => data.onLabelChange(id, value)}
          rows={Math.max(1, value.split("\n").length)}
          className={`w-full resize-none border-0 bg-transparent p-0 text-sm outline-none focus-visible:outline-none ${
            done ? "text-muted-foreground line-through" : ""
          }`}
          placeholder="Untitled to-do"
        />
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );

  if (data.readOnly) return card;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={card} />
      <ContextMenuContent>
        <ContextMenuItem onClick={() => data.onConvertType(id, "graph")}>
          <StickyNote data-icon="inline-start" />
          Convert to note
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => data.onDelete(id)}>
          <Trash2 data-icon="inline-start" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const nodeTypes = { graphNode: GraphLabelNode, todoNode: TodoNode };

function graphToFlow(
  graph: FlowchartGraph,
  positions: Record<string, { x: number; y: number }>,
  readOnly: boolean,
  onLabelChange: (id: string, label: string) => void,
  onToggleDone: (id: string, done: boolean) => void,
  onConvertType: (id: string, kind: NodeKind) => void,
  onDelete: (id: string) => void,
  meta?: Record<string, GraphNodeMeta>,
  animatedEdges = true,
): { nodes: GraphFlowNode[]; edges: Edge[] } {
  const nodes: GraphFlowNode[] = graph.nodes.map((n, i) => {
    const nodeMeta = meta?.[n.id];
    const kind: NodeKind = nodeMeta?.kind === "todo" ? "todo" : "graph";
    return {
      id: n.id,
      type: kind === "todo" ? "todoNode" : "graphNode",
      position: positions[n.id] ?? autoPosition(i),
      data: {
        label: n.label,
        readOnly,
        kind,
        done: nodeMeta?.done === true,
        onLabelChange,
        onToggleDone,
        onConvertType,
        onDelete,
      },
    };
  });
  const edges: Edge[] = graph.edges.map((e) => ({
    id: `${e.source}->${e.target}:${e.label ?? ""}`,
    source: e.source,
    target: e.target,
    label: e.label,
    animated: animatedEdges,
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
  onDirtyChange?: (documentId: string, dirty: boolean) => void;
  onPersisting?: (documentId: string) => void;
  onPersisted?: (documentId: string) => void;
  onSaveError?: (documentId: string) => void;
  /** Targeted request; split editors must not all flush together. */
  saveRequest?: { nonce: number; documentId: string } | null;
}

function GraphEditorInner({
  engine,
  documentId,
  readOnly = false,
  onDirtyChange,
  onPersisting,
  onPersisted,
  onSaveError,
  saveRequest = null,
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

  const [meta, setMeta] = useState<Record<string, GraphNodeMeta>>({});
  const [animatedEdges, setAnimatedEdges] = useState(true);
  const metaRef = useRef(meta);
  useEffect(() => {
    metaRef.current = meta;
  }, [meta]);
  const animatedEdgesRef = useRef(animatedEdges);
  useEffect(() => {
    animatedEdgesRef.current = animatedEdges;
  }, [animatedEdges]);

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
      onPersisting?.(documentId);
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
        if (!disposed.current) onPersisted?.(documentId);
      } catch (err) {
        console.error("[graph] persist failed", err);
        if (!disposed.current) onSaveError?.(documentId);
      }
    },
    [engine, documentId, readOnly, onPersisting, onPersisted, onSaveError],
  );

  const schedulePersist = useCallback(
    (nextNodes: GraphFlowNode[], nextEdges: Edge[]) => {
      onDirtyChange?.(documentId, true);
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

  // Layout-only persistence. Node positions never touch the Markdown, so
  // this never triggers a document persist; it also carries the per-node
  // `meta` (kind/done) and the edge-animation preference, which live in the
  // layout file because the Mermaid source has no slot for them. Reads the
  // previously stored layout first so a non-position write (e.g. toggling a
  // to-do's done flag) doesn't drop recorded viewport/other-device state.
  const scheduleLayoutSave = useCallback(
    (nextNodes: GraphFlowNode[]) => {
      if (readOnly) return;
      if (layoutTimer.current) clearTimeout(layoutTimer.current);
      layoutTimer.current = setTimeout(() => {
        void (async () => {
          const existing =
            (await readGraphLayout(engine.docStore, documentId)) ?? undefined;
          const layoutNodes: Record<string, { x: number; y: number }> = {};
          for (const n of nextNodes) {
            layoutNodes[n.id] = { x: n.position.x, y: n.position.y };
          }
          // Read from the refs, which the 400ms debounce always outlives.
          const meta: Record<string, GraphNodeMeta> = {};
          for (const [id, m] of Object.entries(metaRef.current)) {
            if (id in layoutNodes) meta[id] = m;
          }
          await writeGraphLayout(engine.docStore, documentId, {
            nodes: layoutNodes,
            viewport: existing?.viewport,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
            animatedEdges: animatedEdgesRef.current,
          });
        })();
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
        onToggleDone,
        onConvertType,
        onDelete,
        layout?.meta,
        layout?.animatedEdges ?? true,
      );
      setMeta(layout?.meta ?? {});
      setAnimatedEdges(layout?.animatedEdges ?? true);
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

  const onToggleDone = useCallback(
    (id: string, done: boolean) => {
      if (readOnly) return;
      const next = nodesRef.current.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, done } } : n,
      );
      setNodes(next);
      setMeta((m) => ({
        ...m,
        [id]: { ...(m[id] ?? { kind: "todo" }), done, kind: "todo" },
      }));
      // Done state only lives in the layout file, so just save that.
      scheduleLayoutSave(next);
    },
    [readOnly, setNodes, scheduleLayoutSave],
  );

  const onConvertType = useCallback(
    (id: string, kind: NodeKind) => {
      if (readOnly) return;
      const next = nodesRef.current.map((n) =>
        n.id === id
          ? {
              ...n,
              type: kind === "todo" ? "todoNode" : "graphNode",
              data: {
                ...n.data,
                kind,
                done: kind === "todo" ? n.data.done === true : undefined,
              },
            }
          : n,
      );
      setNodes(next);
      const prev = metaRef.current[id] ?? {};
      setMeta((m) => ({
        ...m,
        [id]:
          kind === "todo"
            ? { ...prev, kind }
            : { ...prev, kind, done: undefined },
      }));
      // Kind only lives in the layout file, so just save that.
      scheduleLayoutSave(next);
    },
    [readOnly, setNodes, scheduleLayoutSave],
  );

  const onDelete = useCallback(
    (id: string) => {
      if (readOnly) return;
      const nextNodes = nodesRef.current.filter((n) => n.id !== id);
      const nextEdges = edgesRef.current.filter(
        (e) => e.source !== id && e.target !== id,
      );
      setNodes(nextNodes);
      setEdges(nextEdges);
      schedulePersist(nextNodes, nextEdges);
      scheduleLayoutSave(nextNodes);
    },
    [readOnly, setNodes, setEdges, schedulePersist, scheduleLayoutSave],
  );

  const onToggleAnimatedEdges = useCallback(() => {
    if (readOnly) return;
    const next = !animatedEdgesRef.current;
    setAnimatedEdges(next);
    scheduleLayoutSave(nodesRef.current);
  }, [readOnly, scheduleLayoutSave]);

  // Re-apply the animation flag to freshly loaded edges when the preference
  // changes (a mount-time no-op, since graphToFlow already set it for the
  // current value; matters when the user flips the toolbar toggle).
  useEffect(() => {
    setEdges((prev) => prev.map((e) => ({ ...e, animated: animatedEdges })));
  }, [animatedEdges, setEdges]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      // addEdge() stamps nothing onto newly-created edges, so carry the
      // animation preference through explicitly (source/target handle only).
      const next = addEdge(
        { ...connection, animated: animatedEdgesRef.current },
        edgesRef.current,
      );
      setEdges(next);
      schedulePersist(nodesRef.current, next);
    },
    [readOnly, setEdges, schedulePersist],
  );

  const addNode = useCallback(
    (kind: NodeKind, position?: { x: number; y: number }) => {
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
      const todo = kind === "todo";
      const next: GraphFlowNode[] = [
        ...nodesRef.current,
        {
          id,
          type: todo ? "todoNode" : "graphNode",
          position: pos,
          // Give it a name: an empty label serialises as `id[""]`, which
          // reads as an empty box in any other Mermaid renderer.
          data: {
            label: todo ? "To-do" : "Node",
            readOnly,
            kind,
            done: false,
            onLabelChange,
            onToggleDone,
            onConvertType,
            onDelete,
          },
        },
      ];
      setNodes(next);
      setMeta((m) => ({ ...m, [id]: { kind, done: false } }));
      schedulePersist(next, edgesRef.current);
      scheduleLayoutSave(next);
    },
    [
      readOnly,
      setNodes,
      onLabelChange,
      onToggleDone,
      onConvertType,
      onDelete,
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
      addNode("graph", pos);
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
        const nodesAfter = nodesRef.current;
        setTimeout(() => schedulePersist(nodesAfter, edgesRef.current), 0);
        // Prune the removed node's meta from the layout file too.
        setTimeout(() => scheduleLayoutSave(nodesAfter), 0);
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
    if (!saveRequest || saveRequest.documentId !== documentId || readOnly) return;
    void persistNow(nodesRef.current, edgesRef.current);
  }, [saveRequest, readOnly, persistNow]);

  const onNodeDoubleClick: NodeMouseHandler = useCallback((e) => {
    e.stopPropagation();
  }, []);

const canEdit = !readOnly;
  const showMinimap = useMinWidth(768);

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <ReactFlow<GraphFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        className="graph-editor-flow"
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
        {showMinimap && (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              n.type === "todoNode"
                ? n.data?.done
                  ? "var(--chart-3)"
                  : "var(--primary)"
                : "var(--muted-foreground)"
            }
            nodeStrokeColor="var(--border)"
          />
        )}
      </ReactFlow>
      <div className="absolute right-3 top-3 z-10 flex gap-2">
        <Tooltip>
          <DropdownMenu>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={!canEdit}
                      aria-label="Add node"
                    >
                      <Plus />
                    </Button>
                  }
                />
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => addNode("graph")}>
                <StickyNote data-icon="inline-start" />
                Note
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addNode("todo")}>
                <ListTodo data-icon="inline-start" />
                To-do
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <TooltipContent side="bottom">Add node</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                disabled={!canEdit}
                aria-label="Auto arrange"
                onClick={autoArrange}
              >
                <Workflow />
              </Button>
            }
          />
          <TooltipContent side="bottom">Auto arrange</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                disabled={!canEdit}
                aria-label="Fit view"
                onClick={() => fitView({ padding: 0.2 })}
              >
                <Maximize2 />
              </Button>
            }
          />
          <TooltipContent side="bottom">Fit view</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={animatedEdges ? "default" : "outline"}
                size="icon"
                disabled={!canEdit}
                aria-label="Animated edges"
                aria-pressed={animatedEdges}
                onClick={onToggleAnimatedEdges}
              >
                <Spline />
              </Button>
            }
          />
          <TooltipContent side="bottom">Animated edges</TooltipContent>
        </Tooltip>
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
