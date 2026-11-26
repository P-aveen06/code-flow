import { Background, Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";
import type { NodeProps, NodeTypes } from "@xyflow/react";
import { useCallback, useId } from "react";
import { layoutFlow } from "../layout/elk";
import type { ModuleNode, SymbolNode } from "../layout/elk";
import type { NodeStatus, OverlayEdge, OverlayNode } from "../types";
import { useRequest } from "../useRequest";
import { edgeStyle, guardLabel, nodeStyle, statusLabels } from "./styles";

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
        <span className="flow-symbol__hint">{symbol.kind} · {statusLabels[symbol.status]}</span>
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

const nodeTypes = { module: ModuleBox, symbol: SymbolCard } satisfies NodeTypes;
const legendStatuses: NodeStatus[] = ["added", "removed", "changed", "context"];

interface FlowCanvasProps {
  nodes: OverlayNode[];
  edges: OverlayEdge[];
  selectedNodeId?: string;
  onNodeClick: (node: OverlayNode) => void;
}

export function FlowCanvas({ nodes, edges, selectedNodeId, onNodeClick }: FlowCanvasProps) {
  const canvasId = useId();
  const loadLayout = useCallback(() => layoutFlow(nodes, edges), [nodes, edges]);
  const layout = useRequest(loadLayout);

  if (!nodes.length) return <p className="panel-message">No flow changes in this comparison.</p>;
  if (layout.status === "loading") return <p className="panel-message" role="status">Laying out the flow…</p>;
  if (layout.status === "error") {
    return <p className="panel-message" role="alert">Could not lay out the flow. {layout.message}</p>;
  }

  return (
    <div className="flow-canvas">
      <ReactFlow
        id={canvasId}
        nodes={layout.data.nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId }))}
        edges={layout.data.edges.map((edge) => {
          const style = edgeStyle(edge.data.status);
          return {
            ...edge,
            style,
            markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
            label: guardLabel(edge.data.guard),
            labelStyle: { fill: "var(--color-text-muted)", fontFamily: "var(--font-mono)" },
            labelBgStyle: { fill: "var(--color-surface)" },
          };
        })}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          if (node.type === "symbol") onNodeClick(node.data.symbol);
        }}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.15 }}
        minZoom={0.06}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
      >
        <Background gap={20} size={1} color="var(--color-border-strong)" />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
      <ul className="flow-legend" aria-label="Change legend">
        {legendStatuses.map((status) => (
          <li key={status}>
            <span className="flow-legend__swatch" style={nodeStyle(status)} />
            {statusLabels[status]}
          </li>
        ))}
      </ul>
    </div>
  );
}
