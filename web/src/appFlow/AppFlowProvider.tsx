// Gives every screen its app_flow state: the flow, each piece, exposure and preview.
// Also sets the style pieces on <html> (tokens.css reads them) and loads the chosen font.
import flagsmith from "@flagsmith/flagsmith";
import type { IFlagsmithFeature } from "@flagsmith/flagsmith";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { readReviewerId, useFlagSnapshot } from "../flags";
import { useLocation } from "../router";
import { applyPreview, experimentSwitches, NO_PREVIEW, readPreview, recordExposure, resolveFlow } from "./flags";
import type { UiFlags } from "./flags";
import { loadFonts } from "./fonts";
import { SignInProvider } from "./SignInContext";
import { APP_FLOW_FLAG, switchFlagName, TODAY_PIECES } from "./types";
import type { AppFlowState, Piece, Switch } from "./types";

const notReady: AppFlowState = {
  ready: false, reviewerId: "", flow: null, pieces: TODAY_PIECES, exposed: false, preview: false,
};

const AppFlowContext = createContext<AppFlowState>({
  ready: true, reviewerId: "", flow: null, pieces: TODAY_PIECES, exposed: false, preview: false,
});

// The flag inputs the provider reads. Before Flagsmith answers, nothing is reachable.
interface FlagInputs {
  reachable: boolean;
  appFlowFlag: IFlagsmithFeature | null;
  uiFlags: UiFlags;
  variantPreview: boolean;
}

const noFlags: FlagInputs = { reachable: false, appFlowFlag: null, uiFlags: {}, variantPreview: false };

// Exposure answers for this page load, so getExperimentFlag runs once per visitor and flag.
const exposures = new Map<string, boolean>();

// The style pieces, and the <html> attribute each one sets (tokens.css reads them).
const styleAttributes: [Switch, string][] = [
  ["font_family", "data-cf-font"],
  ["font_weight", "data-cf-weight"],
  ["line_spacing", "data-cf-leading"],
  ["buttons", "data-cf-buttons"],
  ["colours", "data-cf-colours"],
];

function setStyleAttributes(pieces: AppFlowState["pieces"]) {
  const root = document.documentElement;
  for (const [name, attribute] of styleAttributes) {
    const piece = pieces[name];
    if (piece === "today") root.removeAttribute(attribute);
    else root.setAttribute(attribute, piece);
  }
}

export function AppFlowProvider({ search, children }: { search: string; children: ReactNode }) {
  const { pathname } = useLocation();
  const reviewerId = readReviewerId(search);
  const loaded = useFlagSnapshot(reviewerId);
  const flags: FlagInputs = loaded ?? noFlags;
  const preview = useMemo(
    () => (flags.variantPreview ? readPreview(search) : NO_PREVIEW),
    [search, flags.variantPreview],
  );
  const decision = useMemo(() => applyPreview(
    {
      flow: resolveFlow(flags.reachable ? flags.appFlowFlag : undefined, import.meta.env.VITE_APP_FLOW_FALLBACK),
      uiFlags: flags.uiFlags,
    },
    preview,
  ), [flags, preview]);

  // Exposure is recorded on the landing page only, and never for a preview visitor.
  const exposeAppFlow = pathname === "/" && !decision.preview && flags.reachable
    && flags.appFlowFlag?.enabled === true;
  const exposeSwitches = exposeAppFlow && decision.flow !== null ? experimentSwitches(flags.uiFlags) : [];
  const exposeSwitchKey = exposeSwitches.join(",");
  const [exposure, setExposure] = useState<{ reviewerId: string; exposed: boolean }>();

  useEffect(() => {
    if (!exposeAppFlow) return;
    const exposed = recordExposure(
      reviewerId, APP_FLOW_FLAG, exposures, () => flagsmith.getExperimentFlag(APP_FLOW_FLAG),
    );
    for (const name of exposeSwitches) {
      const flagName = switchFlagName(name);
      recordExposure(reviewerId, flagName, exposures, () => flagsmith.getExperimentFlag(flagName));
    }
    setExposure((current) => (
      current?.reviewerId === reviewerId && current.exposed === exposed ? current : { reviewerId, exposed }
    ));
    // exposeSwitches is fully described by exposeSwitchKey, so it is not a dependency.
  }, [exposeAppFlow, exposeSwitchKey, reviewerId]);

  const ready = loaded !== undefined && (!exposeAppFlow || exposure?.reviewerId === reviewerId);
  const state: AppFlowState = ready
    ? {
      ready,
      reviewerId,
      flow: decision.flow,
      pieces: decision.pieces,
      exposed: !decision.preview && exposure?.reviewerId === reviewerId && exposure.exposed,
      preview: decision.preview,
    }
    : { ...notReady, reviewerId };

  useLayoutEffect(() => setStyleAttributes(state.pieces), [state.pieces]);
  useEffect(() => loadFonts(state.pieces.font_family), [state.pieces.font_family]);

  return (
    <AppFlowContext.Provider value={state}>
      <SignInProvider piece={state.pieces.signin_layout} ready={state.ready}>{children}</SignInProvider>
    </AppFlowContext.Provider>
  );
}

/** Tests render screens with a fixed app_flow state. */
export function AppFlowTestProvider({ value, children }: { value: AppFlowState; children: ReactNode }) {
  return (
    <AppFlowContext.Provider value={value}>
      <SignInProvider piece={value.pieces.signin_layout} ready={value.ready}>{children}</SignInProvider>
    </AppFlowContext.Provider>
  );
}

export function useAppFlow(): AppFlowState {
  return useContext(AppFlowContext);
}

export function usePiece(name: Switch): Piece {
  return useAppFlow().pieces[name];
}
