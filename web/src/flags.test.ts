import { describe, expect, it, vi } from "vitest";
import {
  directionExposureKey, exposeDirectionAssignment, exposeFlowAssignment, readFlowDirection, readReviewerId,
} from "./flags";
import { FLOW_VIEWS } from "./view";

describe("reviewer identity", () => {
  it("generates an ID once and reuses it from storage", () => {
    const items = new Map<string, string>();
    const getStorage = () => ({
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
    });
    const createId = vi.fn(() => "generated");
    expect(readReviewerId("", getStorage, createId)).toBe("generated");
    expect(readReviewerId("?commit=abc", getStorage, createId)).toBe("generated");
    expect(createId).toHaveBeenCalledTimes(1);
  });

  it("uses the URL override without touching storage", () => {
    const getStorage = vi.fn();
    expect(readReviewerId("?reviewer=demo%201", getStorage)).toBe("demo 1");
    expect(getStorage).not.toHaveBeenCalled();
  });

  it("keeps a tab ID when storage is blocked or full", () => {
    const blocked = () => { throw new Error("blocked"); };
    const full = () => ({ getItem: () => null, setItem: blocked });
    const id = readReviewerId("", blocked);
    expect(id).toBeTruthy();
    expect(readReviewerId("", blocked)).toBe(id);
    expect(readReviewerId("", full)).toBe(id);
  });
});

describe("experiment exposure", () => {
  it.each([...FLOW_VIEWS, "", "unknown"])("skips the SDK exposure read when view=%s", (view) => {
    const readExperimentValue = vi.fn(() => "overlay");
    expect(exposeFlowAssignment("demo-1", "assignment", view, undefined, readExperimentValue)).toBeUndefined();
    expect(readExperimentValue).not.toHaveBeenCalled();
  });

  it("reuses the exposed assignment after previewing other variants", () => {
    const readExperimentValue = vi.fn(() => "overlay");
    const assigned = exposeFlowAssignment("demo-1", "assignment", null, undefined, readExperimentValue);
    const preview = exposeFlowAssignment("demo-1", "assignment", "side_by_side", assigned, readExperimentValue);
    const returned = exposeFlowAssignment("demo-1", "assignment", null, preview, readExperimentValue);

    expect(returned).toBe(assigned);
    expect(returned?.view).toBe("overlay");
    expect(readExperimentValue).toHaveBeenCalledTimes(1);
  });

  it("exposes a changed assignment on return from preview", () => {
    const readExperimentValue = vi.fn().mockReturnValueOnce("overlay").mockReturnValueOnce("overlay_summary");
    const assigned = exposeFlowAssignment("demo-1", "original", null, undefined, readExperimentValue);
    const preview = exposeFlowAssignment("demo-1", "updated", "side_by_side", assigned, readExperimentValue);
    expect(preview).toBe(assigned);
    expect(readExperimentValue).toHaveBeenCalledTimes(1);

    const returned = exposeFlowAssignment("demo-1", "updated", null, preview, readExperimentValue);
    expect(returned?.view).toBe("overlay_summary");
    expect(readExperimentValue).toHaveBeenCalledTimes(2);
  });
});

describe("flow direction assignment", () => {
  const flag = {
    enabled: true, value: "vertical", variant: "Vertical",
    experiment: { id: 1, name: "Flow direction", inExperiment: true },
  };

  it("records one exposure per assignment per reviewer, across eligible diffs and polls", () => {
    const exposures = new Set<string>();
    const read = vi.fn(() => flag);
    const evaluate = (reviewerId: string, longFlow: boolean, override: string | null = null) =>
      exposeDirectionAssignment(directionExposureKey(reviewerId, longFlow, override, flag), exposures, read);

    expect(evaluate("demo-1", false)).toBe(false);
    expect(evaluate("demo-1", true, "horizontal")).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(evaluate("demo-1", true)).toBe(true);
    expect(evaluate("demo-1", false)).toBe(false);
    expect(evaluate("demo-1", true)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(evaluate("demo-2", true)).toBe(true);
    expect(evaluate("demo-1", true)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);

    const newFlag = { ...flag, experiment: { ...flag.experiment, id: 2 } };
    const key = directionExposureKey("demo-1", true, null, newFlag);
    const readNew = vi.fn(() => newFlag);
    expect(exposeDirectionAssignment(key, exposures, readNew)).toBe(true);
    expect(readNew).toHaveBeenCalledOnce();
  });

  it.each(["horizontal", "vertical", "", "unknown"])("skips exposure with direction=%s", (direction) => {
    expect(directionExposureKey("demo", true, direction, flag)).toBeNull();
  });

  it.each([
    undefined, null, { ...flag, value: null }, { ...flag, value: "other" }, { ...flag, enabled: false },
  ])("falls back to horizontal without exposure for unavailable assignments", (assignment) => {
    expect(readFlowDirection("", true, assignment).direction).toBe("horizontal");
    expect(directionExposureKey("demo", true, null, assignment)).toBeNull();
  });

  it("uses the flag value without exposure when the reviewer is outside the experiment", () => {
    const assignment = { ...flag, experiment: { ...flag.experiment, inExperiment: false } };
    expect(readFlowDirection("", true, assignment).direction).toBe("vertical");
    expect(directionExposureKey("demo", true, null, assignment)).toBeNull();
  });

  it("honors direction previews and ignores the assignment on short flows", () => {
    expect(readFlowDirection("", false, flag).direction).toBe("horizontal");
    expect(readFlowDirection("?direction=vertical", false, flag).direction).toBe("vertical");
    expect(readFlowDirection("?view=overlay&direction=horizontal", true, flag).direction).toBe("horizontal");
    expect(readFlowDirection("?direction=unknown", true, flag).direction).toBe("horizontal");
    expect(readFlowDirection("?view=overlay", true, flag).direction).toBe("vertical");
  });

  it("does not remember an exposure when the SDK returns no experiment flag", () => {
    const exposures = new Set<string>();
    const key = directionExposureKey("demo", true, null, flag);
    expect(exposeDirectionAssignment(key, exposures, () => null)).toBe(false);
    expect(exposeDirectionAssignment(key, exposures, () => flag)).toBe(true);
  });
});
