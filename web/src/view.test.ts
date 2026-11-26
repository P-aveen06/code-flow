import { describe, expect, it, vi } from "vitest";
import { chooseFlowView, FLOW_VIEWS, readViewOverride } from "./view";

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
