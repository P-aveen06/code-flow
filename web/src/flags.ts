import flagsmith from "@flagsmith/flagsmith";
import { useEffect, useState } from "react";
import { chooseFlowView, readViewOverride } from "./view";
import type { FlowView } from "./view";

const reviewerKey = "code-flow:reviewer";
const pollInterval = 10_000;
let tabReviewerId: string | undefined;
let initialization: Promise<void> | undefined;

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
    fetch: (url: string, options: RequestInit) => fetch(url, {
      ...options, signal: options.signal ?? AbortSignal.timeout(5_000),
    }),
  }));
}

interface FlagValues {
  flowView: FlowView;
  flagsmithMode: boolean;
  notice?: string;
}

export function useCodeFlowFlags(search: string) {
  const reviewerId = readReviewerId(search);
  const viewOverride = readViewOverride(search);
  const [result, setResult] = useState<{
    reviewerId: string; viewOverride: string | null; values: FlagValues;
  }>();

  useEffect(() => {
    const key = import.meta.env.VITE_CODEFLOW_FLAGSMITH_ENV_KEY?.trim();
    let active = true;
    let timer: number | undefined;
    let lastAssignment: { key: string; view: FlowView } | undefined;
    const publish = (values: FlagValues) => setResult({ reviewerId, viewOverride, values });
    const fallback = (notice: string) => publish({
      flowView: chooseFlowView(viewOverride, () => null), flagsmithMode: false, notice,
    });

    if (!key) {
      fallback("Flagsmith is unconfigured. Using default flags.");
      return;
    }

    async function refresh(initialKey?: string) {
      try {
        if (initialKey) await initFlagsmith(initialKey);
        if (!active) return;
        await (initialKey ? flagsmith.identify(reviewerId) : flagsmith.getFlags());
        if (!active) return;

        // Read a new assignment once. Polling the same assignment should not
        // generate more experiment exposures.
        const flag = flagsmith.getAllFlags().flow_view;
        const assignmentKey = JSON.stringify([flag?.value, flag?.variant, flag?.enabled, flag?.experiment]);
        if (lastAssignment?.key !== assignmentKey) {
          const view = chooseFlowView(viewOverride, () => flagsmith.getExperimentFlag("flow_view")?.value);
          lastAssignment = { key: assignmentKey, view };
        }
        publish({ flowView: lastAssignment.view, flagsmithMode: flagsmith.hasFeature("flagsmith_mode") });
      } catch {
        if (active) fallback("Flagsmith is unavailable. Using default flags.");
      } finally {
        if (active) timer = window.setTimeout(() => void refresh(), pollInterval);
      }
    }

    void refresh(key);
    return () => { active = false; window.clearTimeout(timer); };
  }, [reviewerId, viewOverride]);

  const values = result?.reviewerId === reviewerId && result.viewOverride === viewOverride ? result.values : null;
  return {
    reviewerId, viewOverride, ready: values !== null,
    flowView: values?.flowView ?? chooseFlowView(viewOverride, () => null),
    flagsmithMode: values?.flagsmithMode ?? false,
    notice: values?.notice,
  };
}
