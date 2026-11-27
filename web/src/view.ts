import { navigate } from "./router";

export type FlowView = "side_by_side" | "overlay" | "overlay_summary";
export type FlowDirection = "horizontal" | "vertical";
export type SyncMode = "manual_button" | "per_repo_toggle" | "global_toggle";

export const FLOW_VIEWS: readonly FlowView[] = ["side_by_side", "overlay", "overlay_summary"];
export const FLOW_DIRECTIONS: readonly FlowDirection[] = ["horizontal", "vertical"];
export const SYNC_MODES: readonly SyncMode[] = ["manual_button", "per_repo_toggle", "global_toggle"];

export function readPreviewOverrides(search: string, previewEnabled: boolean) {
  const params = new URLSearchParams(previewEnabled ? search : "");
  return {
    viewOverride: params.get("view"), directionOverride: params.get("direction"), syncOverride: params.get("sync"),
  };
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

export function parseSyncMode(value: unknown): SyncMode | null {
  return SYNC_MODES.find((mode) => mode === value) ?? null;
}

export function replaceViewOverride(view: FlowView | null) {
  replaceOverride("view", view);
}

export function replaceDirectionOverride(direction: FlowDirection | null) {
  replaceOverride("direction", direction);
}

export function replaceSyncOverride(mode: SyncMode | null) {
  replaceOverride("sync", mode);
}

export function syncPreviewPath(path: string, override: string | null) {
  return override === null ? path : `${path}?${new URLSearchParams({ sync: override })}`;
}

function replaceOverride(param: "view" | "direction" | "sync", value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(param);
  else url.searchParams.set(param, value);
  navigate(url.href, { replace: true });
}
