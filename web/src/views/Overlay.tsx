import type { FlowLayout } from "../layout/elk";
import type { DiffViewModel, FlagFinding, OverlayNode } from "../types";
import type { FlowDirection } from "../view";
import { FlowCanvas } from "./FlowCanvas";
import type { DiagramFullscreen } from "./fullscreen";
import type { LayoutPositionControls } from "./layoutPositions";

export interface DiffViewProps {
  diff: DiffViewModel;
  layout: FlowLayout;
  direction: FlowDirection;
  layoutPositions: LayoutPositionControls;
  fullscreen: DiagramFullscreen;
  selectedNodeId?: string;
  selectedFlag?: FlagFinding;
  liveStates: ReadonlyMap<string, boolean>;
  onNodeClick: (node: OverlayNode) => void;
  onExpandModule: (module: string) => void;
  onReady: () => void;
}

export function Overlay({ diff: _diff, ...canvas }: DiffViewProps) {
  return <FlowCanvas {...canvas} />;
}
