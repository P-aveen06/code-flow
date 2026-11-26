export type FlowView = "side_by_side" | "overlay" | "overlay_summary";

export const FLOW_VIEWS: readonly FlowView[] = ["side_by_side", "overlay", "overlay_summary"];

export function readFlowView(search: string): FlowView {
  const value = new URLSearchParams(search).get("view");
  return FLOW_VIEWS.find((view) => view === value) ?? "overlay";
}
