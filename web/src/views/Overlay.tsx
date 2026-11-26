import type { FlowLayout } from "../layout/elk";
import type { DiffViewModel, OverlayNode } from "../types";
import { FlowCanvas } from "./FlowCanvas";

export interface DiffViewProps {
  diff: DiffViewModel;
  layout: FlowLayout;
  selectedNodeId?: string;
  onNodeClick: (node: OverlayNode) => void;
  onExpandModule: (module: string) => void;
  onReady: () => void;
}

export function Overlay({ layout, selectedNodeId, onNodeClick, onExpandModule, onReady }: DiffViewProps) {
  return (
    <FlowCanvas
      layout={layout}
      selectedNodeId={selectedNodeId}
      onNodeClick={onNodeClick}
      onExpandModule={onExpandModule}
      onReady={onReady}
    />
  );
}
