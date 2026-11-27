import flagsmith, { FlagSource } from "@flagsmith/flagsmith";
import type { IFlagsmith, IFlagsmithFeature } from "@flagsmith/flagsmith";
import { useEffect, useState } from "react";
import {
  chooseFlowView, parseFlowDirection, parseFlowView, parseSyncMode, readPreviewOverrides,
} from "./view";
import type { FlowView } from "./view";

const reviewerKey = "code-flow:reviewer";
const pollInterval = 10_000;
const requestTimeout = 2_500;
let tabReviewerId: string | undefined;
let initialization: Promise<void> | undefined;
const directionExposures = new Set<string>();
const syncExposures = new Set<string>();

function getTabReviewerId() {
  return (tabReviewerId ??= crypto.randomUUID?.() ?? Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join(""));
}

export function readReviewerId(
  search: string,
  getStorage: () => Pick<Storage, "getItem" | "setItem"> = () => window.localStorage,
  createId: () => string = getTabReviewerId,
) {
  const override = new URLSearchParams(search).get("reviewer");
  if (override) return override;

  let id: string | undefined;
  try {
    const storage = getStorage();
    const saved = storage.getItem(reviewerKey);
    if (saved) return saved;
    id = createId();
    storage.setItem(reviewerKey, id);
  } catch {
    // The same generated ID remains available in this tab if storage is blocked.
  }
  return id ?? createId();
}

function initFlagsmith(api: string, environmentID: string) {
  return (initialization ??= flagsmith.init({
    api,
    environmentID,
    enableEvents: true,
    eventProcessorConfig: { eventsApiUrl: api.replace(/\/v1\/?$/, "/") },
    // The first request should use the reviewer identity.
    preventFetch: true,
    defaultFlags: {},
    fetch: (url: string, options: RequestInit) => {
      // The SDK appends v1/events. Match the API's trailing slash and let
      // event batches within the browser's keepalive limit finish on unload.
      if (url.endsWith("/v1/events")) {
        const keepalive = typeof options.body === "string" && new Blob([options.body]).size <= 64 * 1024;
        return fetch(`${url}/`, { ...options, keepalive });
      }
      const timeout = AbortSignal.timeout(requestTimeout);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      return fetch(url, { ...options, signal });
    },
  }).then(() => {
    // The SDK outlives the viewer, so keep flushing across route changes.
    const flush = () => { void flagsmith.flushEvents(); };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
  }));
}

interface FlagSnapshot {
  assignmentKey?: string;
  assignedView: FlowView | null;
  directionFlag: IFlagsmithFeature | null;
  syncFlag: IFlagsmithFeature | null;
  flagsmithMode: boolean;
  variantPreview: boolean;
}

const unavailableFlags: FlagSnapshot = {
  assignedView: null, directionFlag: null, syncFlag: null, flagsmithMode: false, variantPreview: false,
};

function hasServerFlags(client: Pick<IFlagsmith, "loadingState">) {
  return client.loadingState?.source === FlagSource.SERVER && !client.loadingState.error;
}

export function readFlagSnapshot(client: Pick<IFlagsmith, "loadingState" | "getAllFlags" | "hasFeature">): FlagSnapshot {
  if (!hasServerFlags(client)) return unavailableFlags;
  const { flow_view: viewFlag, flow_direction: directionFlag, sync_mode: syncFlag } = client.getAllFlags();
  return {
    assignmentKey: JSON.stringify([viewFlag?.value, viewFlag?.variant, viewFlag?.enabled, viewFlag?.experiment]),
    assignedView: parseFlowView(viewFlag?.value),
    directionFlag: directionFlag ?? null,
    syncFlag: syncFlag ?? null,
    flagsmithMode: client.hasFeature("flagsmith_mode"),
    variantPreview: client.hasFeature("variant_preview"),
  };
}

interface FlowAssignment {
  reviewerId: string;
  key: string;
  view: FlowView | null;
  exposed: boolean;
}

export function exposeFlowAssignment(
  reviewerId: string, key: string, previewOverride: string | null,
  previous: FlowAssignment | undefined, readExperimentFlag: () => IFlagsmithFeature | null,
): FlowAssignment | undefined {
  if (previewOverride !== null || (previous?.reviewerId === reviewerId && previous.key === key)) {
    return previous;
  }
  const flag = readExperimentFlag();
  return {
    reviewerId, key, view: parseFlowView(flag?.value),
    exposed: flag?.enabled === true && flag.experiment?.inExperiment === true,
  };
}

export function readSyncMode(flag: IFlagsmithFeature | null | undefined, override: string | null) {
  const assignedSyncMode = flag?.enabled ? parseSyncMode(flag.value) : null;
  return {
    assignedSyncMode,
    syncMode: parseSyncMode(override ?? assignedSyncMode) ?? "manual_button",
  } as const;
}

export function syncExposureKey(
  reviewerId: string, override: string | null, flag: IFlagsmithFeature | null | undefined,
) {
  const { assignedSyncMode } = readSyncMode(flag, override);
  if (override !== null || assignedSyncMode === null) return null;
  return JSON.stringify([
    reviewerId, flag?.experiment?.id, flag?.experiment?.inExperiment, flag?.variant, assignedSyncMode,
  ]);
}

export function useCodeFlowFlags(search: string, surface: "viewer" | "landing" = "viewer") {
  const reviewerId = readReviewerId(search);
  const api = import.meta.env.VITE_FLAGSMITH_API_URL?.trim();
  const key = import.meta.env.VITE_CODEFLOW_FLAGSMITH_ENV_KEY?.trim();
  const [result, setResult] = useState<FlagSnapshot & { reviewerId: string }>();
  const [assignment, setAssignment] = useState<FlowAssignment>();

  useEffect(() => {
    if (!api || !key) return;
    let active = true;
    let timer: number | undefined;
    const fallback = () => setResult({ reviewerId, ...unavailableFlags });
    const initialize = () => initFlagsmith(api, key);

    async function refresh(initial = false) {
      try {
        if (initial) await initialize();
        if (!active) return;
        await (initial ? flagsmith.identify(reviewerId) : flagsmith.getFlags());
        if (!active) return;
        setResult({ reviewerId, ...readFlagSnapshot(flagsmith) });
      } catch {
        if (active) fallback();
      } finally {
        if (active) timer = window.setTimeout(() => void refresh(), pollInterval);
      }
    }

    void refresh(true);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, key, reviewerId]);

  const flags = !api || !key ? unavailableFlags : result?.reviewerId === reviewerId ? result : undefined;
  const variantPreview = flags?.variantPreview ?? false;
  const { viewOverride, directionOverride, syncOverride } = readPreviewOverrides(search, variantPreview);
  const previewOverride = viewOverride ?? directionOverride ?? syncOverride;
  const assignmentKey = flags?.assignmentKey;
  useEffect(() => {
    if (surface !== "viewer" || assignmentKey === undefined) return;
    // Keep the last exposure across polling and preview changes.
    const next = exposeFlowAssignment(
      reviewerId, assignmentKey, previewOverride, assignment,
      () => flagsmith.getExperimentFlag("flow_view"),
    );
    if (next !== assignment) setAssignment(next);
  }, [assignment, assignmentKey, reviewerId, previewOverride, surface]);

  const syncKey = surface === "landing" ? syncExposureKey(reviewerId, previewOverride, flags?.syncFlag) : null;
  useEffect(() => {
    if (syncKey === null || syncExposures.has(syncKey)) return;
    if (flagsmith.getContext().identity?.identifier !== reviewerId || !hasServerFlags(flagsmith)) return;
    if (syncExposureKey(reviewerId, null, flagsmith.getAllFlags().sync_mode) !== syncKey) return;
    flagsmith.getExperimentFlag("sync_mode");
    syncExposures.add(syncKey);
  }, [reviewerId, syncKey]);

  const currentAssignment = assignment?.reviewerId === reviewerId && assignment.key === assignmentKey
    ? assignment
    : undefined;
  const assignedView = currentAssignment ? currentAssignment.view : flags?.assignedView ?? null;
  const ready = Boolean(flags && (previewOverride !== null || currentAssignment || assignmentKey === undefined));
  return {
    reviewerId, viewOverride, directionOverride, syncOverride, variantPreview, ready, assignedView,
    ...readSyncMode(flags?.syncFlag, syncOverride),
    flowView: chooseFlowView(viewOverride, () => assignedView),
    flagsmithMode: flags?.flagsmithMode ?? false,
    reviewEventClient: previewOverride === null && currentAssignment?.exposed && assignedView !== null ? flagsmith : null,
    directionFlag: flags?.directionFlag,
  };
}

function flagDirection(flag: IFlagsmithFeature | null | undefined) {
  return flag?.enabled ? parseFlowDirection(flag.value) : null;
}

export function directionExposureKey(
  reviewerId: string, longFlow: boolean | undefined, override: string | null,
  flag: IFlagsmithFeature | null | undefined,
) {
  const direction = flagDirection(flag);
  if (longFlow !== true || override !== null || !direction || !flag?.experiment?.inExperiment) return null;
  return JSON.stringify([reviewerId, flag.experiment.id, flag.variant, direction]);
}

export function exposeDirectionAssignment(
  key: string | null, exposures: Set<string>, readExperimentFlag: () => IFlagsmithFeature | null,
) {
  if (key === null) return false;
  if (exposures.has(key)) return true;
  const flag = readExperimentFlag();
  if (!flagDirection(flag) || !flag?.experiment?.inExperiment) return false;
  exposures.add(key);
  return true;
}

export function readFlowDirection(
  directionOverride: string | null, longFlow: boolean | undefined,
  flag: IFlagsmithFeature | null | undefined,
) {
  const assignedDirection = longFlow === true ? flagDirection(flag) : null;
  // Production rollout for long flows from docs/experiment-results.md.
  const fallback = longFlow === true ? "vertical" : "horizontal";
  return {
    direction: parseFlowDirection(directionOverride ?? assignedDirection) ?? fallback,
    assignedDirection,
    ready: directionOverride !== null || longFlow === false || (longFlow === true && flag !== undefined),
  };
}

export function useDirectionExposure(
  reviewerId: string, key: string | null, rendered: boolean,
) {
  const [exposure, setExposure] = useState<{ key: string; recorded: boolean }>();

  useEffect(() => {
    if (!rendered || key === null) return;
    const recorded = exposeDirectionAssignment(key, directionExposures, () => {
      const currentFlag = flagsmith.getAllFlags().flow_direction;
      if (flagsmith.getContext().identity?.identifier !== reviewerId
        || !hasServerFlags(flagsmith)
        || directionExposureKey(reviewerId, true, null, currentFlag) !== key) return null;
      return flagsmith.getExperimentFlag("flow_direction");
    });
    setExposure({ key, recorded });
  }, [key, rendered, reviewerId]);

  return {
    client: flagsmith,
    exposed: rendered && key !== null && exposure?.key === key && exposure.recorded,
    ready: key === null || exposure?.key === key,
  };
}
