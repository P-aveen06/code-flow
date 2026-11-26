import { describe, expect, it } from "vitest";
import { chooseFitTarget, includeLabelBounds } from "./fit";

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

it("includes badges past the edges of the graph when fitting the canvas", () => {
  expect(includeLabelBounds(
    { x: 0, y: 0, width: 700, height: 500 },
    { x: 120, y: -48, width: 720, height: 90 },
  )).toEqual({ x: 0, y: -48, width: 840, height: 548 });
});
