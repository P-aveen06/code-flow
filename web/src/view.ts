import { navigate } from "./router";

export type FlowView = "side_by_side" | "overlay" | "overlay_summary";

export const FLOW_VIEWS: readonly FlowView[] = ["side_by_side", "overlay", "overlay_summary"];

export function readViewOverride(search: string): string | null {
  return new URLSearchParams(search).get("view");
}

export function chooseFlowView(override: string | null, readExperimentValue: () => unknown): FlowView {
  return parseFlowView(override ?? readExperimentValue()) ?? "side_by_side";
}

export function parseFlowView(value: unknown): FlowView | null {
  return FLOW_VIEWS.find((view) => view === value) ?? null;
}

export function replaceViewOverride(view: FlowView | null) {
  const url = new URL(window.location.href);
  if (view === null) url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  navigate(url.href, { replace: true });
}
