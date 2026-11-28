// Piece rules for app_flow (docs/APP_FLOW_BUILD.md, "Resolving a piece" and "Preview").
// Pure functions: AppFlowProvider feeds them the flag snapshot and the URL, and uses the results.
import type { IFlagsmithFeature } from "@flagsmith/flagsmith";
import { FLOWS, SWITCHES, switchFlagName } from "./types";
import type { Flow, Piece, Pieces, Switch } from "./types";

export type UiFlags = Partial<Record<Switch, IFlagsmithFeature>>;

// From ?app_flow=: pin a flow, or turn app_flow off.
export type FlowOverride = Flow | "off";
// From ?ui_<switch>=: follow app_flow, show today's UI, or pin a flow.
export type PieceOverride = "flow" | "off" | Flow;

export interface Preview {
  appFlow?: FlowOverride;
  pieces: Partial<Record<Switch, PieceOverride>>;
}

// What Flagsmith said, before any preview override.
export interface FlagsAnswer {
  flow: Flow | null;
  uiFlags: UiFlags;
}

export interface AppFlowDecision {
  flow: Flow | null;
  pieces: Pieces;
  // True when a preview override decided the flow or a piece.
  preview: boolean;
}

export type PreviewStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const PREVIEW_STORAGE_KEY = "code-flow:app-flow-preview";
export const NO_PREVIEW: Preview = { pieces: {} };

export function parseFlow(value: unknown): Flow | null {
  return FLOWS.find((flow) => flow === value) ?? null;
}

/**
 * The flow from app_flow. `undefined` means Flagsmith did not answer, so VITE_APP_FLOW_FALLBACK
 * decides. `null` means the answer has no app_flow flag, which is the same as app_flow off.
 */
export function resolveFlow(
  appFlowFlag: IFlagsmithFeature | null | undefined, fallbackEnv: string | undefined,
): Flow | null {
  if (appFlowFlag === undefined) return parseFlow(fallbackEnv);
  return appFlowFlag?.enabled ? parseFlow(appFlowFlag.value) : null;
}

/** One piece. With app_flow off every piece is today's. A missing ui flag follows the flow. */
export function resolvePiece(flag: IFlagsmithFeature | undefined, flow: Flow | null): Piece {
  if (flow === null) return "today";
  if (!flag) return flow;
  if (!flag.enabled) return "today";
  return parseFlow(flag.value) ?? flow;
}

export function resolvePieces(uiFlags: UiFlags, flow: Flow | null): Pieces {
  return Object.fromEntries(SWITCHES.map((name) => [name, resolvePiece(uiFlags[name], flow)])) as Pieces;
}

function parseFlowOverride(value: unknown): FlowOverride | undefined {
  if (value === "off") return "off";
  return parseFlow(value) ?? undefined;
}

function parsePieceOverride(value: unknown): PieceOverride | undefined {
  if (value === "off" || value === "flow") return value;
  return parseFlow(value) ?? undefined;
}

function pieceOverrides(valueOf: (name: Switch) => unknown): Preview["pieces"] {
  const pieces: Preview["pieces"] = {};
  for (const name of SWITCHES) {
    const choice = parsePieceOverride(valueOf(name));
    if (choice !== undefined) pieces[name] = choice;
  }
  return pieces;
}

function readUrlPreview(params: URLSearchParams): Preview {
  return {
    appFlow: parseFlowOverride(params.get("app_flow")),
    pieces: pieceOverrides((name) => params.get(switchFlagName(name))),
  };
}

function parseStoredPreview(value: unknown): Preview {
  if (typeof value !== "object" || value === null) return NO_PREVIEW;
  const { appFlow, pieces } = value as { appFlow?: unknown; pieces?: unknown };
  const stored = typeof pieces === "object" && pieces !== null ? pieces as Record<string, unknown> : {};
  return { appFlow: parseFlowOverride(appFlow), pieces: pieceOverrides((name) => stored[name]) };
}

function readStoredPreview(getStorage: () => PreviewStorage): Preview {
  try {
    const saved = getStorage().getItem(PREVIEW_STORAGE_KEY);
    return saved === null ? NO_PREVIEW : parseStoredPreview(JSON.parse(saved));
  } catch {
    // Blocked or malformed storage means nothing is saved.
    return NO_PREVIEW;
  }
}

function saveStoredPreview(getStorage: () => PreviewStorage, preview: Preview): void {
  try {
    const storage = getStorage();
    if (hasOverrides(preview)) storage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(preview));
    else storage.removeItem(PREVIEW_STORAGE_KEY);
  } catch {
    // The overrides still apply to this page view when storage is blocked.
  }
}

function hasOverrides(preview: Preview): boolean {
  return preview.appFlow !== undefined || Object.keys(preview.pieces).length > 0;
}

function mergePreview(saved: Preview, fromUrl: Preview): Preview {
  return { appFlow: fromUrl.appFlow ?? saved.appFlow, pieces: { ...saved.pieces, ...fromUrl.pieces } };
}

/**
 * The overrides in the URL (?app_flow=, ?ui_<switch>=), merged over the ones saved for this tab.
 * ?app_flow=reset clears the saved ones first. Call only when variant_preview is on.
 */
export function readPreview(
  search: string, getStorage: () => PreviewStorage = () => window.sessionStorage,
): Preview {
  const params = new URLSearchParams(search);
  const reset = params.get("app_flow") === "reset";
  const fromUrl = readUrlPreview(params);
  const preview = mergePreview(reset ? NO_PREVIEW : readStoredPreview(getStorage), fromUrl);
  if (reset || hasOverrides(fromUrl)) saveStoredPreview(getStorage, preview);
  return preview;
}

function previewFlow(flow: Flow | null, override: FlowOverride | undefined): Flow | null {
  if (override === undefined) return flow;
  return override === "off" ? null : override;
}

function previewPiece(override: PieceOverride, flow: Flow | null): Piece {
  if (override === "off") return "today";
  if (override === "flow") return flow ?? "today";
  return override;
}

/**
 * Applies the preview over Flagsmith's answer. An overridden flow also decides the pieces that have
 * no override of their own. The caller only applies a preview when variant_preview is on.
 */
export function applyPreview(answer: FlagsAnswer, preview: Preview): AppFlowDecision {
  const flow = previewFlow(answer.flow, preview.appFlow);
  const pieces = Object.fromEntries(SWITCHES.map((name) => {
    const override = preview.pieces[name];
    const piece = override === undefined
      ? resolvePiece(answer.uiFlags[name], flow)
      : previewPiece(override, flow);
    return [name, piece];
  })) as Pieces;
  return { flow, pieces, preview: hasOverrides(preview) };
}

/**
 * Asks the SDK for one flag's experiment assignment, once per visitor. The SDK records the exposure
 * on that call, so `exposures` keeps the answer for later landing visits.
 */
export function recordExposure(
  reviewerId: string, flagName: string, exposures: Map<string, boolean>,
  readExperimentFlag: () => IFlagsmithFeature | null,
): boolean {
  const key = JSON.stringify([reviewerId, flagName]);
  const recorded = exposures.get(key);
  if (recorded !== undefined) return recorded;
  const flag = readExperimentFlag();
  const exposed = flag?.enabled === true && flag.experiment?.inExperiment === true;
  exposures.set(key, exposed);
  return exposed;
}

/** The live ui_<switch> flags that are part of an experiment, such as a stacking round. */
export function experimentSwitches(uiFlags: UiFlags): Switch[] {
  return SWITCHES.filter((name) => uiFlags[name]?.enabled === true && Boolean(uiFlags[name]?.experiment));
}
