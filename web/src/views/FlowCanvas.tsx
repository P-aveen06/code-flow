import {
  Background, ControlButton, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import type { EdgeTypes, NodeProps, NodeTypes, OnMove, ReactFlowInstance } from "@xyflow/react";
import { useEffect, useEffectEvent, useId, useMemo, useRef } from "react";
import type { ChipNode, FlowEdge, FlowLayout, FlowNode, ModuleNode, SymbolNode } from "../layout/elk";
import type { FlagFinding, NodeStatus, OverlayNode } from "../types";
import type { FlowDirection } from "../view";
import { contextLabel } from "./collapse";
import { guardActivity, highlightedPaths } from "./flagFindings";
import { diagramFit, includeLabelBounds } from "./fit";
import type { DiagramFullscreen } from "./fullscreen";
import { applyLayoutPositions } from "./layoutPositions";
import type { LayoutPositionControls } from "./layoutPositions";
import { RoutedEdge } from "./RoutedEdge";
import { sideOf } from "./sides";
import type { Revision } from "./sides";
import { LineCounts } from "./LineCounts";
import { edgeStyle, guardLabel, nodeStyle, shortFilePath, statusLabels, symbolKindLabel, symbolLabel, symbolName, symbolNameLines } from "./styles";

function ModuleBox({ data }: NodeProps<ModuleNode>) {
  return <div className="flow-module" title={data.label}>{data.label}</div>;
}

export function SymbolCard({ symbol, selected }: { symbol: OverlayNode; selected: boolean }) {
  const name = symbolName(symbol);
  return (
    <button
      type="button" className="flow-symbol" style={nodeStyle(symbol.status)}
      aria-pressed={selected} aria-label={symbolLabel(symbol)} title={name}
    >
      <span className="flow-symbol__top">
        <span className="flow-symbol__kind">{symbolKindLabel(symbol.kind)}</span>
        <span className="flow-symbol__name">
          {symbolNameLines(name).map((line, index) => <span key={index}>{line}</span>)}
        </span>
        {symbol.status !== "context" && <LineCounts added={symbol.lines_added} removed={symbol.lines_removed} />}
      </span>
      {symbol.file && (
        <span className="flow-symbol__file" title={symbol.file}>
          <span>{shortFilePath(symbol.file)}</span><span>:{symbol.line}</span>
        </span>
      )}
    </button>
  );
}

function SymbolFlowNode({ data: { symbol }, selected, sourcePosition, targetPosition }: NodeProps<SymbolNode>) {
  return (
    <>
      <Handle type="target" position={targetPosition ?? Position.Left} isConnectable={false} />
      <SymbolCard symbol={symbol} selected={selected} />
      <Handle type="source" position={sourcePosition ?? Position.Right} isConnectable={false} />
    </>
  );
}

function ContextChip({ data: { chip, label }, sourcePosition, targetPosition }: NodeProps<ChipNode>) {
  const fullLabel = contextLabel(chip);
  return (
    <>
      <Handle type="target" position={targetPosition ?? Position.Left} isConnectable={false} />
      <button
        type="button"
        className="btn btn--sm flow-context"
        aria-label={`Expand ${fullLabel}`}
        aria-expanded={false}
        title={fullLabel}
      >{label}</button>
      <Handle type="source" position={sourcePosition ?? Position.Right} isConnectable={false} />
    </>
  );
}

const nodeTypes = { module: ModuleBox, symbol: SymbolFlowNode, context: ContextChip } satisfies NodeTypes;
const edgeTypes = { routed: RoutedEdge } satisfies EdgeTypes;
const legendStatuses: NodeStatus[] = ["added", "removed", "changed", "context"];
const minZoom = 0.06;
const dragThreshold = 4;
export type FlowInstance = ReactFlowInstance<FlowNode, FlowEdge>;

interface FlowCanvasProps {
  layout: FlowLayout;
  direction: FlowDirection;
  revision?: Revision;
  layoutPositions: LayoutPositionControls;
  fullscreen: DiagramFullscreen;
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

export function flowHandlePositions(direction: FlowDirection) {
  return direction === "vertical"
    ? { sourcePosition: Position.Bottom, targetPosition: Position.Top }
    : { sourcePosition: Position.Right, targetPosition: Position.Left };
}

function Canvas({
  layout, direction, revision, layoutPositions, fullscreen, selectedNodeId, selectedFlag, liveStates, onNodeClick,
  onExpandModule, onReady, onInit, onMove, autoFit = true, controlsPosition = "bottom-right", emptyMessage,
}: FlowCanvasProps) {
  const canvasId = useId();
  const canvasRef = useRef<HTMLDivElement>(null);
  const readyLayout = useRef<FlowLayout | null>(null);
  const dragged = useRef(false);
  const { setViewport, viewportInitialized } = useReactFlow<FlowNode, FlowEdge>();
  const positioned = useMemo(
    () => applyLayoutPositions(layout, layoutPositions.positions, direction),
    [layout, layoutPositions.positions, direction],
  );
  const displayed = useMemo(() => revision ? sideOf(positioned, revision) : positioned, [positioned, revision]);
  const highlight = useMemo(() => highlightedPaths(layout.nodes, layout.edges, selectedFlag), [layout, selectedFlag]);
  const nodes = useMemo(() => displayed.nodes.map((node) => ({
    ...node,
    ...flowHandlePositions(direction),
    selected: node.id === selectedNodeId && !node.hidden,
    className: highlight && !highlight.nodeIds.has(node.id) ? "flow-node--dimmed" : undefined,
    zIndex: node.type === "module" ? 0 : 2,
  })), [displayed.nodes, direction, selectedNodeId, highlight]);
  const edges = useMemo(() => displayed.edges.map((edge) => {
    const activity = guardActivity(edge.data.guard, liveStates);
    const style = edgeStyle(edge.data.status, activity);
    return {
      ...edge,
      type: "routed",
      zIndex: 1,
      label: edge.label ? guardLabel(edge.data.guard, activity) : undefined,
      style: { ...style, opacity: highlight && !highlight.edgeIds.has(edge.id) ? 0.22 : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
    };
  }), [displayed.edges, liveStates, highlight]);

  function fit(allowFocus: boolean) {
    const canvas = canvasRef.current;
    if (!canvas) return Promise.resolve(false);
    let { labelBounds } = displayed;
    if (revision) {
      const other = sideOf(positioned, revision === "base" ? "head" : "base").labelBounds;
      if (other) labelBounds = labelBounds ? includeLabelBounds(labelBounds, other) : other;
    }
    const viewport = diagramFit({ ...positioned, labelBounds }, canvas.clientWidth, canvas.clientHeight, controlsPosition, allowFocus);
    return viewport ? setViewport(viewport) : Promise.resolve(false);
  }

  const fitLatestLayout = useEffectEvent(() => fit(true));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !autoFit || !viewportInitialized) return;

    let fitFrame = 0;
    let resizeTimer: ReturnType<typeof setTimeout>;
    let width = canvas.clientWidth;
    let height = canvas.clientHeight;
    let disposed = false;
    function markReady() {
      if (disposed || readyLayout.current === layout) return;
      readyLayout.current = layout;
      onReady?.();
    }
    const scheduleFit = () => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        void fitLatestLayout().then(markReady, markReady);
      });
    };

    scheduleFit();
    const observer = new ResizeObserver(() => {
      const nextWidth = canvas.clientWidth;
      const nextHeight = canvas.clientHeight;
      if (width === nextWidth && height === nextHeight) return;
      width = nextWidth;
      height = nextHeight;
      // Fit once the canvas stops resizing during a divider drag.
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(scheduleFit, 120);
    });
    observer.observe(canvas);

    return () => {
      disposed = true;
      observer.disconnect();
      clearTimeout(resizeTimer);
      cancelAnimationFrame(fitFrame);
    };
  }, [autoFit, fullscreen.active, layout, layoutPositions.resetCount, onReady, viewportInitialized]);

  const fullscreenLabel = fullscreen.active ? "Exit full screen" : "Full screen";

  return (
    <div className="flow-canvas" ref={canvasRef} onPointerDownCapture={() => { dragged.current = false; }}>
      <ReactFlow
        id={canvasId}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={onInit}
        onMove={onMove}
        onNodesChange={layoutPositions.onNodesChange}
        onNodeDragStart={() => { dragged.current = true; }}
        onNodeDragStop={(_, _node, movedNodes) => layoutPositions.finishDrag(movedNodes)}
        onNodeClick={(event, node) => {
          if (dragged.current && event.detail !== 0) return;
          if (node.type === "symbol") onNodeClick(node.data.symbol);
          if (node.type === "context") onExpandModule(node.data.chip.module);
        }}
        minZoom={minZoom}
        zIndexMode="manual"
        nodesDraggable
        nodeDragThreshold={dragThreshold}
        nodeClickDistance={dragThreshold}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
      >
        <Background gap={20} size={1} color="var(--color-border-strong)" />
        {layout.nodes.length > 0 && (
          <Controls
            className="flow-controls"
            position={controlsPosition}
            orientation="horizontal"
            showInteractive={false}
            showFitView={false}
          >
            <ControlButton title="Fit view" aria-label="Fit view" onClick={() => void fit(false)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6M9 9h6v6H9z" /></svg>
            </ControlButton>
            <ControlButton className="flow-controls__text" title="Reset layout" onClick={layoutPositions.reset}
              disabled={!layoutPositions.positions.size}
            >Reset layout</ControlButton>
            <ControlButton title={`${fullscreenLabel} (F)`} aria-label={fullscreenLabel}
              aria-keyshortcuts={fullscreen.active ? "F Escape" : "F"} onClick={() => void fullscreen.toggle()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={fullscreen.active ? "M3 9h6V3m12 6h-6V3M3 15h6v6m12-6h-6v6" : "M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"} />
              </svg>
            </ControlButton>
          </Controls>
        )}
      </ReactFlow>
      {!displayed.nodes.length && emptyMessage && <p className="panel-message flow-canvas__empty">{emptyMessage}</p>}
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
