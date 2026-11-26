import { describe, expect, it } from "vitest";
import { edgeStyle, guardLabel, nodeStyle, symbolNameLines, symbolSize } from "./styles";

describe("flow styles", () => {
  it("uses status colors for symbols, with a dashed border for removals", () => {
    expect(nodeStyle("added")).toMatchObject({ borderColor: "var(--color-success)", borderStyle: "solid" });
    expect(nodeStyle("removed")).toMatchObject({ borderColor: "var(--color-danger)", borderStyle: "dashed" });
    expect(nodeStyle("changed")).toMatchObject({ borderColor: "var(--color-warning)", borderStyle: "solid" });
    expect(nodeStyle("context")).toMatchObject({ borderColor: "var(--color-text-subtle)", borderStyle: "solid" });
  });

  it("uses status colors for arrows, with a dashed stroke for removals", () => {
    expect(edgeStyle("added")).toMatchObject({ stroke: "var(--color-success)", strokeDasharray: undefined });
    expect(edgeStyle("removed")).toMatchObject({ stroke: "var(--color-danger)", strokeDasharray: "6 4" });
    expect(edgeStyle("context")).toMatchObject({ stroke: "var(--color-text-subtle)", strokeDasharray: undefined });
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
    expect(symbolSize(name)).toEqual({ width: 312, height: 56 });
    expect(symbolSize("load_model")).toEqual({ width: 140, height: 36 });
  });
});
