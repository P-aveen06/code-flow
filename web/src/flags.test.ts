import { describe, expect, it, vi } from "vitest";
import { exposeFlowAssignment, readReviewerId } from "./flags";
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
