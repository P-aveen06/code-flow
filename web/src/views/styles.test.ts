import { describe, expect, it } from "vitest";
import { edgeStyle, guardLabel, nodeStyle } from "./styles";

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
});
