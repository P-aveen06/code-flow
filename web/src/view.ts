export type FlowView = "side_by_side" | "overlay" | "overlay_summary";

export const FLOW_VIEWS: readonly FlowView[] = ["side_by_side", "overlay", "overlay_summary"];

export function readViewOverride(search: string): string | null {
  return new URLSearchParams(search).get("view");
}

export function chooseFlowView(override: string | null, readExperimentValue: () => unknown): FlowView {
  const value = override ?? readExperimentValue();
  return FLOW_VIEWS.find((view) => view === value) ?? "side_by_side";
}
