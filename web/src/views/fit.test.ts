import { describe, expect, it } from "vitest";
import { chooseFitTarget } from "./fit";

describe("chooseFitTarget", () => {
  it("fits all nodes when the whole diagram is readable", () => {
    expect(chooseFitTarget(0.9, 0.65)).toBe("all");
  });

  it("fits all nodes at the readable minimum", () => {
    expect(chooseFitTarget(0.65, 0.65)).toBe("all");
  });

  it("focuses on changes when fitting all nodes is below the readable minimum", () => {
    expect(chooseFitTarget(0.64, 0.65)).toBe("changed");
  });
});
