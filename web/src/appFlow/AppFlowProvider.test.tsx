// @vitest-environment happy-dom

import flagsmith from "@flagsmith/flagsmith";
import type { IFlagsmithFeature } from "@flagsmith/flagsmith";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFlowProvider, useAppFlow } from "./AppFlowProvider";
import type { AppFlowState } from "./types";

// The flag snapshot the next render sees. Undefined until Flagsmith answers.
const snapshot = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("../flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flags")>()),
  useFlagSnapshot: () => snapshot.current,
}));

let root: Root;
let container: HTMLDivElement;
let visitors = 0;
const experiment = vi.fn<(name: string) => IFlagsmithFeature | null>();

function flag(enabled: boolean, value: unknown, inExperiment?: boolean): IFlagsmithFeature {
  const experimentField = inExperiment === undefined ? undefined : { id: 1, name: "Stacking round", inExperiment };
  return { enabled, value, experiment: experimentField } as unknown as IFlagsmithFeature;
}

function answered(
  { appFlow = null, ui = {}, variantPreview = false }: {
    appFlow?: IFlagsmithFeature | null; ui?: Record<string, IFlagsmithFeature>; variantPreview?: boolean;
  } = {},
) {
  return { reachable: true, appFlowFlag: appFlow, uiFlags: ui, variantPreview };
}

// What the snapshot looks like when Flagsmith is not configured or did not answer.
function unreachable() {
  return { reachable: false, appFlowFlag: null, uiFlags: {}, variantPreview: false };
}

// Each test is a new visitor, so exposure answers from earlier tests do not apply.
function nextVisitor() {
  visitors += 1;
  return `?reviewer=visitor-${visitors}`;
}

function Probe() {
  return <pre>{JSON.stringify(useAppFlow())}</pre>;
}

async function renderApp(search: string, path = "/") {
  window.history.replaceState(null, "", path);
  await act(async () => root.render(<AppFlowProvider search={search}><Probe /></AppFlowProvider>));
  return JSON.parse(container.textContent ?? "{}") as AppFlowState;
}

const styleAttributes = ["data-cf-font", "data-cf-weight", "data-cf-leading", "data-cf-buttons", "data-cf-colours"];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  experiment.mockReset().mockReturnValue(flag(true, "b", true));
  vi.spyOn(flagsmith, "getExperimentFlag").mockImplementation(experiment);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  for (const attribute of styleAttributes) document.documentElement.removeAttribute(attribute);
});

describe("readiness and fallback", () => {
  it("shows nothing until Flagsmith answers", async () => {
    snapshot.current = undefined;
    const state = await renderApp(nextVisitor());
    expect(state).toMatchObject({ ready: false, flow: null, exposed: false });
    expect(Object.values(state.pieces).every((piece) => piece === "today")).toBe(true);
  });

  it("uses VITE_APP_FLOW_FALLBACK when Flagsmith did not answer", async () => {
    vi.stubEnv("VITE_APP_FLOW_FALLBACK", "b");
    snapshot.current = unreachable();
    const state = await renderApp(nextVisitor());
    expect(state).toMatchObject({ ready: true, flow: "b", exposed: false });
    expect(Object.values(state.pieces).every((piece) => piece === "b")).toBe(true);
    expect(document.documentElement.dataset.cfFont).toBe("b");
    expect(experiment).not.toHaveBeenCalled();
  });

  it("is today's UI without a fallback", async () => {
    snapshot.current = unreachable();
    const state = await renderApp(nextVisitor());
    expect(state).toMatchObject({ ready: true, flow: null });
    expect(state.pieces).toMatchObject({ font_family: "today", colours: "today" });
    expect(document.documentElement.hasAttribute("data-cf-font")).toBe(false);
  });
});

describe("pieces and style attributes", () => {
  it("resolves each piece from its own flag", async () => {
    snapshot.current = answered({
      appFlow: flag(true, "b"),
      ui: { colours: flag(false, "a"), buttons: flag(true, "c") },
    });
    const state = await renderApp(nextVisitor(), "/github");
    expect(state.pieces).toMatchObject({ colours: "today", buttons: "c", font_family: "b" });
    expect(document.documentElement.getAttribute("data-cf-font")).toBe("b");
    expect(document.documentElement.getAttribute("data-cf-buttons")).toBe("c");
    expect(document.documentElement.hasAttribute("data-cf-colours")).toBe(false);
  });

  it("removes the attributes when the flow goes off", async () => {
    snapshot.current = answered({ appFlow: flag(true, "a") });
    const search = nextVisitor();
    await renderApp(search, "/github");
    expect(document.documentElement.getAttribute("data-cf-font")).toBe("a");

    snapshot.current = answered({ appFlow: flag(false, "a") });
    await renderApp(search, "/github");
    expect(document.documentElement.hasAttribute("data-cf-font")).toBe(false);
  });
});

describe("exposure", () => {
  it("records the app_flow exposure once per visitor on the landing page", async () => {
    snapshot.current = answered({ appFlow: flag(true, "b") });
    const search = nextVisitor();

    const landing = await renderApp(search, "/");
    expect(landing).toMatchObject({ ready: true, flow: "b", exposed: true });
    expect(experiment).toHaveBeenCalledOnce();
    expect(experiment).toHaveBeenCalledWith("app_flow");

    await renderApp(search, "/github");
    await renderApp(search, "/");
    expect(experiment).toHaveBeenCalledOnce();
  });

  it("is not recorded off the landing page", async () => {
    snapshot.current = answered({ appFlow: flag(true, "b") });
    const state = await renderApp(nextVisitor(), "/github");
    expect(state).toMatchObject({ ready: true, flow: "b", exposed: false });
    expect(experiment).not.toHaveBeenCalled();
  });

  it("is not recorded for a visitor outside the experiment", async () => {
    experiment.mockReturnValue(flag(true, "b", false));
    snapshot.current = answered({ appFlow: flag(true, "b") });
    const state = await renderApp(nextVisitor(), "/");
    expect(state).toMatchObject({ ready: true, flow: "b", exposed: false });
  });

  it("records the ui experiments of a stacking round on the landing page", async () => {
    snapshot.current = answered({ appFlow: flag(true, "b"), ui: { colours: flag(true, "a", true) } });
    await renderApp(nextVisitor(), "/");
    expect(experiment.mock.calls.map(([name]) => name)).toEqual(["app_flow", "ui_colours"]);
  });

  it("records no ui experiment while app_flow is off", async () => {
    snapshot.current = answered({ ui: { colours: flag(true, "a", true) } });
    const state = await renderApp(nextVisitor(), "/");
    expect(state).toMatchObject({ ready: true, flow: null, exposed: false });
    expect(experiment).not.toHaveBeenCalled();
  });
});

describe("preview", () => {
  it("applies ?app_flow= when variant_preview is on, and is never exposed", async () => {
    snapshot.current = answered({ appFlow: flag(true, "b"), variantPreview: true });
    const state = await renderApp(`${nextVisitor()}&app_flow=c`, "/");
    expect(state).toMatchObject({ ready: true, flow: "c", preview: true, exposed: false });
    expect(experiment).not.toHaveBeenCalled();
  });

  it("keeps the preview for later pages in the same tab", async () => {
    snapshot.current = answered({ appFlow: flag(true, "b"), variantPreview: true });
    const search = nextVisitor();
    await renderApp(`${search}&app_flow=a`, "/");
    const later = await renderApp(search, "/github");
    expect(later).toMatchObject({ flow: "a", preview: true });
  });

  it("ignores ?app_flow= when variant_preview is off", async () => {
    snapshot.current = answered({ appFlow: flag(true, "b"), variantPreview: false });
    const state = await renderApp(`${nextVisitor()}&app_flow=c`, "/github");
    expect(state).toMatchObject({ flow: "b", preview: false });
  });
});
