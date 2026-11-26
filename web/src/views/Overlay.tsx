import type { FlowLayout } from "../layout/elk";
import type { DiffViewModel, FlagFinding, OverlayNode } from "../types";
import { FlowCanvas } from "./FlowCanvas";

export interface DiffViewProps {
  diff: DiffViewModel;
  layout: FlowLayout;
  selectedNodeId?: string;
  selectedFlag?: FlagFinding;
  liveStates: ReadonlyMap<string, boolean>;
  onNodeClick: (node: OverlayNode) => void;
  onExpandModule: (module: string) => void;
  onReady: () => void;
}

export function Overlay({ layout, selectedNodeId, selectedFlag, liveStates, onNodeClick, onExpandModule, onReady }: DiffViewProps) {
  return (
    <FlowCanvas
      layout={layout}
      selectedNodeId={selectedNodeId}
      selectedFlag={selectedFlag}
      liveStates={liveStates}
      onNodeClick={onNodeClick}
      onExpandModule={onExpandModule}
      onReady={onReady}
    />
  );
}
