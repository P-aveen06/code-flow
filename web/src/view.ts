import { navigate } from "./router";

export type FlowView = "side_by_side" | "overlay" | "overlay_summary";
export type FlowDirection = "horizontal" | "vertical";

export const FLOW_VIEWS: readonly FlowView[] = ["side_by_side", "overlay", "overlay_summary"];
export const FLOW_DIRECTIONS: readonly FlowDirection[] = ["horizontal", "vertical"];

export function readPreviewOverrides(search: string, previewEnabled: boolean) {
  const params = new URLSearchParams(previewEnabled ? search : "");
  return {
    viewOverride: params.get("view"), directionOverride: params.get("direction"),
  };
}

export function chooseFlowView(override: string | null, readExperimentValue: () => unknown): FlowView {
  // Production rollout from docs/experiment-results.md.
  return parseFlowView(override ?? readExperimentValue()) ?? "overlay_summary";
}

export function parseFlowView(value: unknown): FlowView | null {
  return FLOW_VIEWS.find((view) => view === value) ?? null;
}

export function parseFlowDirection(value: unknown): FlowDirection | null {
  return FLOW_DIRECTIONS.find((direction) => direction === value) ?? null;
}

export function replaceViewOverride(view: FlowView | null) {
  replaceOverride("view", view);
}

export function replaceDirectionOverride(direction: FlowDirection | null) {
  replaceOverride("direction", direction);
}

function replaceOverride(param: "view" | "direction", value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(param);
  else url.searchParams.set(param, value);
  navigate(url.href, { replace: true });
}
