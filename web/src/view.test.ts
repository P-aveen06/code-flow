import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseFlowView, FLOW_DIRECTIONS, FLOW_VIEWS, readPreviewOverrides,
  replaceDirectionOverride, replaceSyncOverride, replaceViewOverride, SYNC_MODES,
} from "./view";

describe("chooseFlowView", () => {
  it.each(FLOW_VIEWS)("uses the experiment value %s", (view) => {
    expect(chooseFlowView(null, () => view)).toBe(view);
  });

  it.each([null, undefined, "other", false])("defaults to the rollout for %s", (value) => {
    expect(chooseFlowView(null, () => value)).toBe("overlay_summary");
  });

  it.each([
    ["?view=overlay_summary&reviewer=demo-1", "overlay_summary"],
    ["?view=other", "overlay_summary"],
    ["?view=", "overlay_summary"],
  ])("skips experiment exposure for %s", (search, expected) => {
    const readExperimentValue = vi.fn(() => "overlay");
    expect(chooseFlowView(readPreviewOverrides(search, true).viewOverride, readExperimentValue)).toBe(expected);
    expect(readExperimentValue).not.toHaveBeenCalled();
  });
});

describe("readPreviewOverrides", () => {
  const search = "?view=overlay&direction=horizontal&sync=global_toggle&commit=abc";

  it("reads all URL overrides with previews enabled", () => {
    expect(readPreviewOverrides(search, true)).toEqual({
      viewOverride: "overlay", directionOverride: "horizontal", syncOverride: "global_toggle",
    });
  });

  it("ignores all URL overrides with previews disabled", () => {
    const overrides = readPreviewOverrides(search, false);
    expect(overrides).toEqual({ viewOverride: null, directionOverride: null, syncOverride: null });
    expect(chooseFlowView(overrides.viewOverride, () => "overlay_summary")).toBe("overlay_summary");
  });
});

describe("replaceViewOverride", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockLocation(href: string) {
    const state = { scroll: 12 };
    const replaceState = vi.fn();
    const pushState = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("PopStateEvent", Event);
    vi.stubGlobal("window", {
      location: new URL(href), history: { state, replaceState, pushState }, dispatchEvent,
    });
    return { state, replaceState, pushState, dispatchEvent };
  }

  const repo = "http://localhost:5173/repo/shop-demo";
  const query = "?commit=f376f9c&reviewer=demo-1";

  it.each(FLOW_VIEWS)("previews %s by replacing the current history entry", (view) => {
    const { state, replaceState, pushState, dispatchEvent } = mockLocation(repo + query + "#flow");
    replaceViewOverride(view);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(state, "", new URL(`${repo}${query}&view=${view}#flow`));
    expect(pushState).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "popstate" }));
  });

  it("removes the preview while keeping the commit, reviewer and hash", () => {
    const { state, replaceState, pushState, dispatchEvent } = mockLocation(repo + query + "&view=overlay#flow");
    replaceViewOverride(null);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(state, "", new URL(repo + query + "#flow"));
    expect(pushState).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "popstate" }));
  });

  it.each(FLOW_DIRECTIONS)("replaces the direction with %s and keeps the view preview", (direction) => {
    const page = repo + query + "&view=overlay_summary";
    const { state, replaceState, pushState, dispatchEvent } = mockLocation(page + "#flow");
    replaceDirectionOverride(direction);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(state, "", new URL(`${page}&direction=${direction}#flow`));
    expect(pushState).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "popstate" }));
  });

  it("clears the direction preview and preserves other parameters", () => {
    const page = repo + query + "&view=overlay_summary";
    const { state, replaceState } = mockLocation(page + "&direction=vertical#flow");
    expect(readPreviewOverrides(window.location.search, true).directionOverride).toBe("vertical");
    replaceDirectionOverride(null);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(state, "", new URL(page + "#flow"));
  });

  it.each(SYNC_MODES)("replaces sync with %s and preserves the other previews", (mode) => {
    const page = repo + query + "&view=overlay&direction=vertical";
    const { state, replaceState } = mockLocation(page + "#flow");
    replaceSyncOverride(mode);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(state, "", new URL(`${page}&sync=${mode}#flow`));
  });
});
