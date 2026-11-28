import { describe, expect, it } from "vitest";
import type { OverlayNode } from "../types";
import { edgeStyle, formatLineCounts, guardLabel, nodeStyle, shortFilePath, symbolNameLines, symbolSize } from "./styles";

const symbol: OverlayNode = {
  id: "segments.views:load_model", kind: "function", status: "changed", module: "segments.views",
  name: "load_model", qualname: "load_model", file: "api/segments/views.py", line: 48, end_line: 60,
  in_base: true, in_head: true, lines_added: 12, lines_removed: 3,
};

describe("flow styles", () => {
  it("uses diagram colors and fills for symbols, with a dashed border for removals", () => {
    expect(nodeStyle("added")).toMatchObject({
      backgroundColor: "var(--diagram-added-fill)", borderColor: "var(--diagram-added)", borderStyle: "solid",
    });
    expect(nodeStyle("removed")).toMatchObject({
      backgroundColor: "var(--diagram-removed-fill)", borderColor: "var(--diagram-removed)", borderStyle: "dashed",
    });
    expect(nodeStyle("changed")).toMatchObject({
      backgroundColor: "var(--diagram-changed-fill)", borderColor: "var(--diagram-changed)", borderStyle: "solid",
    });
    expect(nodeStyle("context")).toMatchObject({
      backgroundColor: "var(--diagram-context-fill)", borderColor: "var(--diagram-context)", borderStyle: "solid",
    });
  });

  it("uses diagram colors for arrows, with a dashed stroke for removals", () => {
    expect(edgeStyle("added")).toMatchObject({ stroke: "var(--diagram-added)", strokeDasharray: undefined });
    expect(edgeStyle("removed")).toMatchObject({ stroke: "var(--diagram-removed)", strokeDasharray: "6 4" });
    expect(edgeStyle("context")).toMatchObject({ stroke: "var(--diagram-context)", strokeDasharray: undefined });
  });

  it("labels guarded calls with the flag and branch", () => {
    expect(guardLabel({ flag: "new_checkout", when: "on" })).toBe("new_checkout: on");
    expect(guardLabel({ flag: "new_checkout", when: "off" })).toBe("new_checkout: off");
    expect(guardLabel(null)).toBeUndefined();
  });

  it("wraps long symbol names at word boundaries when possible", () => {
    expect(symbolNameLines("ExperimentRolloutDecisionSerializer.to_spec"))
      .toEqual(["ExperimentRolloutDecision", "Serializer.to_spec"]);
    expect(symbolNameLines("restrict_use_due_to_api_limit_grace_period_over").join(""))
      .toBe("restrict_use_due_to_api_limit_grace_period_over");
  });

  it("keeps very long names within two lines and sizes the box from the displayed text", () => {
    const name = `QualifiedClass.${"very_long_".repeat(14)}method`;
    const lines = symbolNameLines(name);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/…$/);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(28);
    const wrapped = symbolSize({ ...symbol, qualname: name });
    const compact = symbolSize(symbol);
    expect(wrapped.height - compact.height).toBe(17);
    expect(wrapped.width).toBeGreaterThan(compact.width);
    expect(compact.width).toBeGreaterThan(symbolSize({ ...symbol, lines_added: null, lines_removed: null }).width);
  });

  it("shortens paths to two segments", () => {
    expect(shortFilePath("api/project/segments/views.py")).toBe("…/segments/views.py");
    expect(shortFilePath("segments/views.py")).toBe("segments/views.py");
    expect(shortFilePath("views.py")).toBe("views.py");
    expect(shortFilePath("")).toBe("");
  });

  it("formats counts and omits zero or unavailable sides", () => {
    expect(formatLineCounts(12, 3)).toEqual({ added: "+12", removed: "−3" });
    expect(formatLineCounts(0, 3)).toEqual({ added: "", removed: "−3" });
    expect(formatLineCounts(4, 0)).toEqual({ added: "+4", removed: "" });
    expect(formatLineCounts(null, null)).toEqual({ added: "", removed: "" });
    expect(formatLineCounts(0, 0)).toEqual({ added: "", removed: "" });
  });
});
