import type { FlowLayout } from "../layout/elk";
import type { DiffViewModel, OverlayNode } from "../types";
import { FlowCanvas } from "./FlowCanvas";

export interface DiffViewProps {
  diff: DiffViewModel;
  layout: FlowLayout;
  selectedNodeId?: string;
  onNodeClick: (node: OverlayNode) => void;
  onReady: () => void;
}

export function Overlay({ layout, selectedNodeId, onNodeClick, onReady }: DiffViewProps) {
  return (
    <FlowCanvas
      layout={layout}
      selectedNodeId={selectedNodeId}
      onNodeClick={onNodeClick}
      onReady={onReady}
      emptyMessage={layout.nodes.length ? undefined : "No flow changes in this comparison."}
    />
  );
}
