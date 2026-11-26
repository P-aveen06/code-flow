import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import type { EdgeTypes, NodeProps, NodeTypes, OnMove, ReactFlowInstance } from "@xyflow/react";
import { useEffect, useId, useMemo, useRef } from "react";
import type { FlowEdge, FlowLayout, FlowNode, ModuleNode, SymbolNode } from "../layout/elk";
import type { NodeStatus, OverlayNode } from "../types";
import { RoutedEdge } from "./RoutedEdge";
import { edgeStyle, nodeStyle, statusLabels, symbolHint } from "./styles";

function ModuleBox({ data }: NodeProps<ModuleNode>) {
  return <div className="flow-module" title={data.label}>{data.label}</div>;
}

function SymbolCard({ data: { symbol }, selected }: NodeProps<SymbolNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className="flow-symbol"
        style={nodeStyle(symbol.status)}
        aria-expanded={selected}
        title={symbol.qualname}
      >
        <span className="flow-symbol__name">{symbol.qualname}</span>
        <span className="flow-symbol__hint">{symbolHint(symbol)}</span>
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

const nodeTypes = { module: ModuleBox, symbol: SymbolCard } satisfies NodeTypes;
const edgeTypes = { routed: RoutedEdge } satisfies EdgeTypes;
const legendStatuses: NodeStatus[] = ["added", "removed", "changed", "context"];
const fitOptions = { padding: 0.14, maxZoom: 1.25, includeHiddenNodes: true };
export type FlowInstance = ReactFlowInstance<FlowNode, FlowEdge>;

interface FlowCanvasProps {
  layout: FlowLayout;
  selectedNodeId?: string;
  onNodeClick: (node: OverlayNode) => void;
  onReady?: () => void;
  onInit?: (instance: FlowInstance) => void;
  onMove?: OnMove;
  autoFit?: boolean;
  controlsPosition?: "top-right" | "bottom-right";
  emptyMessage?: string;
}

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({
  layout, selectedNodeId, onNodeClick, onReady, onInit, onMove,
  autoFit = true, controlsPosition = "bottom-right", emptyMessage,
}: FlowCanvasProps) {
  const canvasId = useId();
  const canvasRef = useRef<HTMLDivElement>(null);
  const readyLayout = useRef<FlowLayout | null>(null);
  const { fitView, viewportInitialized } = useReactFlow();
  const nodes = useMemo(() => layout.nodes.map(
    (node) => node.id === selectedNodeId && !node.hidden ? { ...node, selected: true } : node,
  ), [layout.nodes, selectedNodeId]);
  const edges = useMemo(() => layout.edges.map((edge) => {
    const style = edgeStyle(edge.data.status);
    return {
      ...edge,
      type: "routed",
      style,
      markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
      labelStyle: { fill: "var(--color-text-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" },
      labelBgStyle: { fill: "var(--color-surface)" },
    };
  }), [layout.edges]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !autoFit) return;

    let fitFrame = 0;
    let readyFrame = 0;
    let disposed = false;
    function markReady() {
      if (disposed || readyLayout.current === layout) return;
      cancelAnimationFrame(readyFrame);
      readyLayout.current = layout;
      onReady?.();
    }
    function scheduleFit() {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        if (!viewportInitialized || !layout.nodes.length) {
          markReady();
          return;
        }
        const fit = fitView(fitOptions);
        if (readyLayout.current !== layout && !readyFrame) {
          void fit.then(markReady, markReady);
          // React Flow can keep a fit queued while waiting for measurements.
          readyFrame = requestAnimationFrame(markReady);
        }
      });
    }

    scheduleFit();
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(canvas);

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      cancelAnimationFrame(readyFrame);
    };
  }, [autoFit, fitView, layout, onReady, viewportInitialized]);

  return (
    <div className="flow-canvas" ref={canvasRef}>
      <ReactFlow
        id={canvasId}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={onInit}
        onMove={onMove}
        onNodesChange={autoFit ? (changes) => {
          if (changes.some(({ type }) => type === "dimensions")) void fitView(fitOptions);
        } : undefined}
        onNodeClick={(_, node) => {
          if (node.type === "symbol") onNodeClick(node.data.symbol);
        }}
        minZoom={0.06}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
      >
        <Background gap={20} size={1} color="var(--color-border-strong)" />
        {layout.nodes.length > 0 && (
          <Controls position={controlsPosition} showInteractive={false} fitViewOptions={fitOptions} />
        )}
      </ReactFlow>
      {emptyMessage && <p className="panel-message flow-canvas__empty">{emptyMessage}</p>}
    </div>
  );
}

export function FlowLegend() {
  return (
    <ul className="flow-legend" aria-label="Change legend">
      {legendStatuses.map((status) => (
        <li key={status}>
          <span className="flow-legend__swatch" style={nodeStyle(status)} />
          {statusLabels[status]}
        </li>
      ))}
    </ul>
  );
}
