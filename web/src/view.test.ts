import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseFlowView, FLOW_VIEWS, readViewOverride, replaceViewOverride } from "./view";

describe("chooseFlowView", () => {
  it.each(FLOW_VIEWS)("uses the experiment value %s", (view) => {
    expect(chooseFlowView(null, () => view)).toBe(view);
  });

  it.each([null, undefined, "other", false])("defaults to control for %s", (value) => {
    expect(chooseFlowView(null, () => value)).toBe("side_by_side");
  });

  it.each([
    ["?view=overlay_summary&reviewer=demo-1", "overlay_summary"],
    ["?view=other", "side_by_side"],
    ["?view=", "side_by_side"],
  ])("skips experiment exposure for %s", (search, expected) => {
    const readExperimentValue = vi.fn(() => "overlay");
    expect(chooseFlowView(readViewOverride(search), readExperimentValue)).toBe(expected);
    expect(readExperimentValue).not.toHaveBeenCalled();
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
});
