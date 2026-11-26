import { navigate } from "./router";

export type FlowView = "side_by_side" | "overlay" | "overlay_summary";
export type FlowDirection = "horizontal" | "vertical";

export const FLOW_VIEWS: readonly FlowView[] = ["side_by_side", "overlay", "overlay_summary"];
export const FLOW_DIRECTIONS: readonly FlowDirection[] = ["horizontal", "vertical"];

export function readViewOverride(search: string): string | null {
  return new URLSearchParams(search).get("view");
}

export function chooseFlowView(override: string | null, readExperimentValue: () => unknown): FlowView {
  return parseFlowView(override ?? readExperimentValue()) ?? "side_by_side";
}

export function parseFlowView(value: unknown): FlowView | null {
  return FLOW_VIEWS.find((view) => view === value) ?? null;
}

export function parseFlowDirection(value: unknown): FlowDirection | null {
  return FLOW_DIRECTIONS.find((direction) => direction === value) ?? null;
}

export function readDirectionOverride(search: string): string | null {
  return new URLSearchParams(search).get("direction");
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
