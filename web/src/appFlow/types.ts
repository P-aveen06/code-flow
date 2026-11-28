// Shared types for the app_flow A/B/C test. See docs/APP_FLOW_BUILD.md.
// CONTRACT FILE: do not change these names or shapes without updating the build doc.

export type Flow = "a" | "b" | "c";
// "today" is today's UI for that piece (the flag is off, or app_flow is off).
export type Piece = "today" | Flow;

export const FLOWS: readonly Flow[] = ["a", "b", "c"];
export const APP_FLOW_FLAG = "app_flow";

// One Flagsmith flag per switch, named `ui_<switch>`. Order matches the flag list.
export const SWITCHES = [
  "font_family",
  "font_weight",
  "line_spacing",
  "buttons",
  "colours",
  "landing_layout",
  "signin_layout",
  "repos_layout",
  "repo_details_layout",
  "flow_view_layout",
  "branch_switch",
] as const;
export type Switch = (typeof SWITCHES)[number];
export type Pieces = Record<Switch, Piece>;

export function switchFlagName(name: Switch): `ui_${Switch}` {
  return `ui_${name}`;
}

export const TODAY_PIECES: Pieces = Object.fromEntries(
  SWITCHES.map((name) => [name, "today"]),
) as Pieces;

export interface AppFlowState {
  // False until Flagsmith answers or fails, so pages do not flash the wrong flow.
  ready: boolean;
  reviewerId: string;
  // null when app_flow is off or Flagsmith is unreachable: every piece is "today".
  flow: Flow | null;
  pieces: Pieces;
  // True only after getExperimentFlag("app_flow") placed this visitor in the experiment.
  exposed: boolean;
  // True when a variant_preview URL override decided the flow or a piece.
  preview: boolean;
}
