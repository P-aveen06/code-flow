import type { Viewport } from "@xyflow/react";
import { useMemo, useRef } from "react";
import type { FlowLayout } from "../layout/elk";
import { FlowCanvas } from "./FlowCanvas";
import type { FlowInstance } from "./FlowCanvas";
import type { DiffViewProps } from "./Overlay";
import { sideOf } from "./sides";
import type { Revision } from "./sides";

function comparisonPane(union: FlowLayout, side: Revision) {
  const visible = sideOf(union, side);
  const visibleIds = new Set(visible.nodes.map(({ id }) => id));

  return {
    layout: {
      // Keep the union's bounds for fitView, including when one side is empty.
      nodes: union.nodes.map((node) => visibleIds.has(node.id) ? node : { ...node, hidden: true }),
      edges: visible.edges,
    },
    empty: visible.nodes.length === 0,
  };
}

export function SideBySide({ diff, layout, selectedNodeId, onNodeClick, onReady }: DiffViewProps) {
  const instances = useRef<Partial<Record<Revision, FlowInstance>>>({});
  const before = useMemo(() => comparisonPane(layout, "base"), [layout]);
  const after = useMemo(() => comparisonPane(layout, "head"), [layout]);

  function syncViewport(side: Revision, viewport: Viewport) {
    const target = instances.current[side];
    if (!target) return;
    const current = target.getViewport();
    // The reflected onMove already has the same transform in the other pane.
    if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) return;
    void target.setViewport(viewport);
  }

  function registerInstance(side: Revision, instance: FlowInstance) {
    instances.current[side] = instance;
    const base = instances.current.base;
    if (base) syncViewport("head", base.getViewport());
  }

  return (
    <div className="side-by-side">
      <section className="side-by-side__pane" aria-label="Before">
        <h3>Before (<code title={diff.base || undefined}>{diff.base.slice(0, 7) || "empty graph"}</code>)</h3>
        <FlowCanvas
          layout={before.layout}
          selectedNodeId={selectedNodeId}
          onNodeClick={onNodeClick}
          onReady={onReady}
          onInit={(instance) => registerInstance("base", instance)}
          onMove={(_, viewport) => syncViewport("head", viewport)}
          controlsPosition="top-right"
          emptyMessage={before.empty ? "No nodes in this comparison before the commit." : undefined}
        />
      </section>
      <section className="side-by-side__pane" aria-label="After">
        <h3>After (<code title={diff.head}>{diff.head.slice(0, 7)}</code>)</h3>
        <FlowCanvas
          layout={after.layout}
          selectedNodeId={selectedNodeId}
          onNodeClick={onNodeClick}
          autoFit={false}
          onInit={(instance) => registerInstance("head", instance)}
          onMove={(_, viewport) => syncViewport("base", viewport)}
          controlsPosition="top-right"
          emptyMessage={after.empty ? "No nodes in this comparison after the commit." : undefined}
        />
      </section>
    </div>
  );
}
