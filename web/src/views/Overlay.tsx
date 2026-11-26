import type { DiffViewModel, OverlayNode } from "../types";
import { FlowCanvas } from "./FlowCanvas";

export interface DiffViewProps {
  diff: DiffViewModel;
  selectedNodeId?: string;
  onNodeClick: (node: OverlayNode) => void;
}

export function Overlay({ diff, selectedNodeId, onNodeClick }: DiffViewProps) {
  return (
    <FlowCanvas
      nodes={diff.nodes}
      edges={diff.edges}
      selectedNodeId={selectedNodeId}
      onNodeClick={onNodeClick}
    />
  );
}
