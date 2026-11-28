import { FlagSource } from "@flagsmith/flagsmith";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BRANCH_COMMIT_COUNT, directionExposureKey, exposeDirectionAssignment, exposeFlowAssignment,
  parseCommitCount, readFlagSnapshot, readFlowDirection, readReviewerId,
} from "./flags";
import { FLOW_DIRECTIONS, FLOW_VIEWS, readPreviewOverrides } from "./view";

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

describe("panel and preview flags in the snapshot", () => {
  const loaded = { source: FlagSource.SERVER, isLoading: false, isFetching: false, error: null };

  it("reads the preview feature on each refresh", () => {
    let previewEnabled = true;
    const hasFeature = vi.fn((flag: string) => flag === "variant_preview" && previewEnabled);
    const client = { loadingState: loaded, hasFeature, getAllFlags: () => ({}) };

    expect(readFlagSnapshot(client).variantPreview).toBe(true);
    previewEnabled = false;
    expect(readFlagSnapshot(client).variantPreview).toBe(false);
    expect(hasFeature.mock.calls.filter(([flag]) => flag === "variant_preview")).toHaveLength(2);
  });

  it.each([true, false])("reads live_flag_panel as %s", (enabled) => {
    const hasFeature = vi.fn((flag: string) => flag === "live_flag_panel" && enabled);
    const flags = readFlagSnapshot({ loadingState: loaded, hasFeature, getAllFlags: () => ({}) });

    expect(hasFeature).toHaveBeenCalledWith("live_flag_panel");
    expect(flags.liveFlagPanel).toBe(enabled);
  });

  it("defaults to off when the SDK reports an unknown flag", () => {
    const flags = readFlagSnapshot({ loadingState: loaded, getAllFlags: () => ({}), hasFeature: () => false });
    expect(flags.variantPreview).toBe(false);
    expect(flags.liveFlagPanel).toBe(false);
  });

  it.each([
    { ...loaded, source: FlagSource.CACHE },
    { ...loaded, error: new Error("Flagsmith unavailable") },
  ])("disables findings and previews when the latest flag fetch is unavailable", (loadingState) => {
    const hasFeature = vi.fn(() => true);
    const flags = readFlagSnapshot({ loadingState, hasFeature, getAllFlags: () => ({}) });

    expect(flags.variantPreview).toBe(false);
    expect(flags.liveFlagPanel).toBe(false);
    expect(hasFeature).not.toHaveBeenCalled();
  });
});

describe("experiment exposure", () => {
  const flag = {
    enabled: true, value: "overlay", experiment: { id: 1, name: "Flow view", inExperiment: true },
  };

  it.each([...FLOW_VIEWS, ...FLOW_DIRECTIONS, "", "unknown"])("skips the SDK exposure read during preview %s", (override) => {
    const readExperimentFlag = vi.fn(() => flag);
    expect(exposeFlowAssignment("demo-1", "assignment", override, undefined, readExperimentFlag)).toBeUndefined();
    expect(readExperimentFlag).not.toHaveBeenCalled();
  });

  it("reuses the exposed assignment after previewing other variants", () => {
    const readExperimentFlag = vi.fn(() => flag);
    const assigned = exposeFlowAssignment("demo-1", "assignment", null, undefined, readExperimentFlag);
    const preview = exposeFlowAssignment("demo-1", "assignment", "side_by_side", assigned, readExperimentFlag);
    const returned = exposeFlowAssignment("demo-1", "assignment", null, preview, readExperimentFlag);

    expect(returned).toBe(assigned);
    expect(returned?.view).toBe("overlay");
    expect(returned?.exposed).toBe(true);
    expect(readExperimentFlag).toHaveBeenCalledTimes(1);
  });

  it("exposes a changed assignment on return from preview", () => {
    const readExperimentFlag = vi.fn().mockReturnValueOnce(flag).mockReturnValueOnce({ ...flag, value: "overlay_summary" });
    const assigned = exposeFlowAssignment("demo-1", "original", null, undefined, readExperimentFlag);
    const preview = exposeFlowAssignment("demo-1", "updated", "side_by_side", assigned, readExperimentFlag);
    expect(preview).toBe(assigned);
    expect(readExperimentFlag).toHaveBeenCalledTimes(1);

    const returned = exposeFlowAssignment("demo-1", "updated", null, preview, readExperimentFlag);
    expect(returned?.view).toBe("overlay_summary");
    expect(readExperimentFlag).toHaveBeenCalledTimes(2);
  });

  it("uses the rolled-out view without marking an exposure", () => {
    const readExperimentFlag = vi.fn(() => ({ enabled: true, value: "overlay_summary" }));
    const assigned = exposeFlowAssignment("demo-1", "rolled-out", null, undefined, readExperimentFlag);
    expect(assigned).toMatchObject({ view: "overlay_summary", exposed: false });
    expect(readExperimentFlag).toHaveBeenCalledOnce();
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
  ])("falls back to vertical on long flows without exposure for unavailable assignments", (assignment) => {
    expect(readFlowDirection(null, true, assignment).direction).toBe("vertical");
    expect(readFlowDirection(null, false, assignment).direction).toBe("horizontal");
    expect(directionExposureKey("demo", true, null, assignment)).toBeNull();
  });

  it("uses the flag value without exposure when the reviewer is outside the experiment", () => {
    const assignment = { ...flag, experiment: { ...flag.experiment, inExperiment: false } };
    expect(readFlowDirection(null, true, assignment).direction).toBe("vertical");
    expect(directionExposureKey("demo", true, null, assignment)).toBeNull();
  });

  it("honors direction previews and ignores the assignment on short flows", () => {
    expect(readFlowDirection(null, false, flag).direction).toBe("horizontal");
    expect(readFlowDirection("vertical", false, flag).direction).toBe("vertical");
    expect(readFlowDirection("horizontal", true, flag).direction).toBe("horizontal");
    expect(readFlowDirection("unknown", true, flag).direction).toBe("vertical");
    expect(readFlowDirection(null, true, flag).direction).toBe("vertical");
  });

  it("uses the layout assignment and exposure rules with ignored overrides", () => {
    const { viewOverride, directionOverride } = readPreviewOverrides("?view=overlay&direction=horizontal", false);
    expect(readFlowDirection(directionOverride, true, flag).direction).toBe("vertical");
    expect(directionExposureKey("demo", true, viewOverride ?? directionOverride, flag)).toBe(
      directionExposureKey("demo", true, null, flag),
    );
  });

  it("does not remember an exposure when the SDK returns no experiment flag", () => {
    const exposures = new Set<string>();
    const key = directionExposureKey("demo", true, null, flag);
    expect(exposeDirectionAssignment(key, exposures, () => null)).toBe(false);
    expect(exposeDirectionAssignment(key, exposures, () => flag)).toBe(true);
  });
});

describe("branch_commit_count remote config", () => {
  const flag = (enabled: boolean, value: unknown) => ({ enabled, value }) as Parameters<typeof parseCommitCount>[0];

  it("reads a whole number from 1 to 200", () => {
    expect(parseCommitCount(flag(true, 30))).toBe(30);
    expect(parseCommitCount(flag(true, "40"))).toBe(40);
    expect(parseCommitCount(flag(true, 200))).toBe(200);
  });

  it.each([
    ["missing", null], ["off", flag(false, 30)], ["zero", flag(true, 0)], ["too many", flag(true, 500)],
    ["fraction", flag(true, 2.5)], ["text", flag(true, "lots")], ["empty", flag(true, null)],
  ])("falls back to 20 when %s", (_, value) => {
    expect(parseCommitCount(value)).toBe(DEFAULT_BRANCH_COMMIT_COUNT);
    expect(DEFAULT_BRANCH_COMMIT_COUNT).toBe(20);
  });

  it("comes from the branch_commit_count flag in the snapshot", () => {
    const commitFlag = { enabled: true, value: 25 };
    const snapshot = readFlagSnapshot({
      loadingState: { error: null, isFetching: false, isLoading: false, source: FlagSource.SERVER },
      getAllFlags: () => ({ branch_commit_count: commitFlag }),
      hasFeature: () => false,
    });
    expect(parseCommitCount(snapshot.commitCountFlag)).toBe(25);
  });
});
