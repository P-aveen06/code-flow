import {
  Background, ControlButton, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, getViewportForBounds,
  useReactFlow,
} from "@xyflow/react";
import type { EdgeTypes, NodeProps, NodeTypes, OnMove, ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import type { ChipNode, FlowEdge, FlowLayout, FlowNode, ModuleNode, SymbolNode } from "../layout/elk";
import type { FlagFinding, NodeStatus, OverlayNode } from "../types";
import { contextLabel } from "./collapse";
import { guardActivity, highlightedPaths } from "./flagFindings";
import { chooseFitTarget, includeLabelBounds } from "./fit";
import { RoutedEdge } from "./RoutedEdge";
import { edgeStyle, guardLabel, nodeStyle, statusLabels, symbolHint, symbolNameLines } from "./styles";

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
        <span className="flow-symbol__name">
          {symbolNameLines(symbol.qualname).map((line, index) => <span key={index}>{line}</span>)}
        </span>
        <span className="flow-symbol__hint">{symbolHint(symbol)}</span>
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

function ContextChip({ data: { chip, label } }: NodeProps<ChipNode>) {
  const fullLabel = contextLabel(chip);
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className="btn btn--sm flow-context"
        aria-label={`Expand ${fullLabel}`}
        aria-expanded={false}
        title={fullLabel}
      >{label}</button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

const nodeTypes = { module: ModuleBox, symbol: SymbolCard, context: ContextChip } satisfies NodeTypes;
const edgeTypes = { routed: RoutedEdge } satisfies EdgeTypes;
const legendStatuses: NodeStatus[] = ["added", "removed", "changed", "context"];
const fitOptions = { padding: 0.14, maxZoom: 1.25, includeHiddenNodes: true };
const readableZoom = 0.65;
const minZoom = 0.06;
export type FlowInstance = ReactFlowInstance<FlowNode, FlowEdge>;

interface FlowCanvasProps {
  layout: FlowLayout;
  selectedNodeId?: string;
  selectedFlag?: FlagFinding;
  liveStates: ReadonlyMap<string, boolean>;
  onNodeClick: (node: OverlayNode) => void;
  onExpandModule: (module: string) => void;
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
  layout, selectedNodeId, selectedFlag, liveStates, onNodeClick, onExpandModule, onReady, onInit, onMove,
  autoFit = true, controlsPosition = "bottom-right", emptyMessage,
}: FlowCanvasProps) {
  const canvasId = useId();
  const canvasRef = useRef<HTMLDivElement>(null);
  const readyLayout = useRef<FlowLayout | null>(null);
  const { fitView, getNodesBounds, setViewport, viewportInitialized } = useReactFlow<FlowNode, FlowEdge>();
  const highlight = useMemo(() => highlightedPaths(layout.nodes, layout.edges, selectedFlag), [layout, selectedFlag]);
  const nodes = useMemo(() => layout.nodes.map((node) => ({
    ...node,
    selected: node.id === selectedNodeId && !node.hidden,
    className: highlight && !highlight.nodeIds.has(node.id) ? "flow-node--dimmed" : undefined,
    zIndex: node.type === "module" ? 0 : 2,
  })), [layout.nodes, selectedNodeId, highlight]);
  const edges = useMemo(() => layout.edges.map((edge) => {
    const activity = guardActivity(edge.data.guard, liveStates);
    const style = edgeStyle(edge.data.status, activity);
    return {
      ...edge,
      type: "routed",
      zIndex: 1,
      label: guardLabel(edge.data.guard, activity),
      style: { ...style, opacity: highlight && !highlight.edgeIds.has(edge.id) ? 0.22 : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
    };
  }), [layout.edges, liveStates, highlight]);

  const fitGuardedFlow = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout.labelBounds) return Promise.resolve(false);
    // Both comparison panes keep the union's node and label bounds.
    const bounds = includeLabelBounds(getNodesBounds(layout.nodes), layout.labelBounds);
    return setViewport(getViewportForBounds(
      bounds, canvas.clientWidth, canvas.clientHeight, minZoom, fitOptions.maxZoom, fitOptions.padding,
    ));
  }, [getNodesBounds, layout, setViewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !autoFit) return;

    let fitFrame = 0;
    let readyFrame = 0;
    let disposed = false;
    const changed = layout.nodes.filter((node) => node.type === "symbol" && node.data.symbol.status !== "context");
    function markReady() {
      if (disposed || readyLayout.current === layout) return;
      cancelAnimationFrame(readyFrame);
      readyLayout.current = layout;
      onReady?.();
    }
    const scheduleFit = () => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        if (!viewportInitialized || !layout.nodes.length) {
          markReady();
          return;
        }
        // Side-by-side panes share the union's bounds, including nodes shown only in the other pane.
        const allBounds = getNodesBounds(layout.nodes);
        const { zoom: allBoundsZoom } = getViewportForBounds(
          allBounds, canvas.clientWidth, canvas.clientHeight, 0, fitOptions.maxZoom, fitOptions.padding,
        );
        const focusChanges = changed.length > 0 && chooseFitTarget(allBoundsZoom, readableZoom) === "changed";
        const fit = layout.labelBounds ? fitGuardedFlow() : fitView(focusChanges ? {
          ...fitOptions, nodes: changed, minZoom: readableZoom, maxZoom: 1,
        } : fitOptions);
        if (readyLayout.current !== layout && !readyFrame) {
          void fit.then(markReady, markReady);
          // React Flow can keep a fit queued while waiting for measurements.
          readyFrame = requestAnimationFrame(markReady);
        }
      });
    };

    scheduleFit();
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(canvas);

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      cancelAnimationFrame(readyFrame);
    };
  }, [autoFit, fitGuardedFlow, fitView, getNodesBounds, layout, onReady, viewportInitialized]);

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
        onNodeClick={(_, node) => {
          if (node.type === "symbol") onNodeClick(node.data.symbol);
          if (node.type === "context") onExpandModule(node.data.chip.module);
        }}
        minZoom={minZoom}
        zIndexMode="manual"
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
      >
        <Background gap={20} size={1} color="var(--color-border-strong)" />
        {layout.nodes.length > 0 && (
          <Controls
            position={controlsPosition}
            showInteractive={false}
            showFitView={!layout.labelBounds}
            fitViewOptions={fitOptions}
          >
            {layout.labelBounds && (
              <ControlButton title="Fit view" aria-label="Fit view" onClick={() => void fitGuardedFlow()}>
                ⛶
              </ControlButton>
            )}
          </Controls>
        )}
      </ReactFlow>
      {emptyMessage && <p className="panel-message flow-canvas__empty">{emptyMessage}</p>}
    </div>
  );
}

export function FlowLegend({ flagsmithMode }: { flagsmithMode: boolean }) {
  return (
    <ul className="flow-legend" aria-label="Change legend">
      {legendStatuses.map((status) => (
        <li key={status}>
          <span className="flow-legend__swatch" style={nodeStyle(status)} />
          {status === "context" ? "Unchanged neighbour" : statusLabels[status]}
        </li>
      ))}
      <li><code>flag: on/off</code> = call depends on a feature flag</li>
      {flagsmithMode && (
        <>
          <li><span className="flow-legend__path flow-legend__path--live" />Live flag path</li>
          <li><span className="flow-legend__path flow-legend__path--off" />Switched-off flag path</li>
        </>
      )}
    </ul>
  );
}
