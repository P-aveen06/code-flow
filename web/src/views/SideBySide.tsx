import type { Viewport } from "@xyflow/react";
import { useRef } from "react";
import { FlowCanvas } from "./FlowCanvas";
import type { FlowInstance } from "./FlowCanvas";
import type { DiffViewProps } from "./Overlay";
import type { Revision } from "./sides";

export function SideBySide({ diff, layout, onReady, ...canvas }: DiffViewProps) {
  const instances = useRef<Partial<Record<Revision, FlowInstance>>>({});

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
          {...canvas}
          layout={layout}
          revision="base"
          onReady={onReady}
          onInit={(instance) => registerInstance("base", instance)}
          onMove={(_, viewport) => syncViewport("head", viewport)}
          controlsPosition="top-right"
          emptyMessage="No nodes in this comparison before the commit."
        />
      </section>
      <section className="side-by-side__pane" aria-label="After">
        <h3>After (<code title={diff.head}>{diff.head.slice(0, 7)}</code>)</h3>
        <FlowCanvas
          {...canvas}
          layout={layout}
          revision="head"
          autoFit={false}
          onInit={(instance) => registerInstance("head", instance)}
          onMove={(_, viewport) => syncViewport("base", viewport)}
          controlsPosition="top-right"
          emptyMessage="No nodes in this comparison after the commit."
        />
      </section>
    </div>
  );
}
