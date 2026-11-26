import flagsmith, { FlagSource } from "@flagsmith/flagsmith";
import type { IFlagsmithFeature } from "@flagsmith/flagsmith";
import { useEffect, useState } from "react";
import {
  chooseFlowView, parseFlowDirection, parseFlowView, readDirectionOverride, readViewOverride,
} from "./view";
import type { FlowView } from "./view";

const reviewerKey = "code-flow:reviewer";
const pollInterval = 10_000;
let tabReviewerId: string | undefined;
let initialization: Promise<void> | undefined;
const directionExposures = new Set<string>();

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

function initFlagsmith(environmentID: string) {
  const api = import.meta.env.VITE_FLAGSMITH_API_URL || "http://localhost:8000/api/v1/";
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
      return fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(5_000) });
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

interface FlagResult {
  reviewerId: string;
  assignmentKey?: string;
  directionFlag: IFlagsmithFeature | null;
  flagsmithMode: boolean;
}

interface FlowAssignment {
  reviewerId: string;
  key: string;
  view: FlowView | null;
}

export function exposeFlowAssignment(
  reviewerId: string, key: string, viewOverride: string | null,
  previous: FlowAssignment | undefined, readExperimentValue: () => unknown,
): FlowAssignment | undefined {
  if (viewOverride !== null || (previous?.reviewerId === reviewerId && previous.key === key)) {
    return previous;
  }
  return { reviewerId, key, view: parseFlowView(readExperimentValue()) };
}

export function useCodeFlowFlags(search: string) {
  const reviewerId = readReviewerId(search);
  const viewOverride = readViewOverride(search);
  const [result, setResult] = useState<FlagResult>();
  const [assignment, setAssignment] = useState<FlowAssignment>();

  useEffect(() => {
    const key = import.meta.env.VITE_CODEFLOW_FLAGSMITH_ENV_KEY?.trim();
    let active = true;
    let timer: number | undefined;
    const fallback = () => setResult({ reviewerId, directionFlag: null, flagsmithMode: false });

    if (!key) {
      fallback();
      return;
    }

    async function refresh(initialKey?: string) {
      try {
        if (initialKey) await initFlagsmith(initialKey);
        if (!active) return;
        await (initialKey ? flagsmith.identify(reviewerId) : flagsmith.getFlags());
        if (!active) return;

        const { flow_view: flag, flow_direction: directionFlag } = flagsmith.getAllFlags();
        const assignmentKey = JSON.stringify([flag?.value, flag?.variant, flag?.enabled, flag?.experiment]);
        setResult({
          reviewerId, assignmentKey,
          directionFlag: flagsmith.loadingState?.source === FlagSource.SERVER && !flagsmith.loadingState.error
            ? directionFlag ?? null : null,
          flagsmithMode: flagsmith.hasFeature("flagsmith_mode"),
        });
      } catch {
        if (active) fallback();
      } finally {
        if (active) timer = window.setTimeout(() => void refresh(), pollInterval);
      }
    }

    void refresh(key);
    return () => { active = false; window.clearTimeout(timer); };
  }, [reviewerId]);

  const flags = result?.reviewerId === reviewerId ? result : undefined;
  const assignmentKey = flags?.assignmentKey;
  useEffect(() => {
    if (assignmentKey === undefined) return;
    // Keep the last exposure across polling and preview changes.
    const next = exposeFlowAssignment(
      reviewerId, assignmentKey, viewOverride, assignment,
      () => flagsmith.getExperimentFlag("flow_view")?.value,
    );
    if (next !== assignment) setAssignment(next);
  }, [assignment, assignmentKey, reviewerId, viewOverride]);

  const currentAssignment = assignment?.reviewerId === reviewerId && assignment.key === assignmentKey
    ? assignment
    : undefined;
  const assignedView = currentAssignment?.view ?? null;
  const ready = viewOverride !== null || Boolean(currentAssignment || (flags && assignmentKey === undefined));
  return {
    reviewerId, viewOverride, ready, assignedView,
    flowView: chooseFlowView(viewOverride, () => assignedView),
    flagsmithMode: flags?.flagsmithMode ?? false,
    reviewEventClient: viewOverride === null && assignedView !== null ? flagsmith : null,
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
  search: string, longFlow: boolean | undefined,
  flag: IFlagsmithFeature | null | undefined,
) {
  const directionOverride = readDirectionOverride(search);
  const assignedDirection = longFlow === true ? flagDirection(flag) : null;
  return {
    direction: parseFlowDirection(directionOverride ?? assignedDirection) ?? "horizontal",
    directionOverride, assignedDirection,
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
        || flagsmith.loadingState?.source !== FlagSource.SERVER
        || flagsmith.loadingState.error
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
