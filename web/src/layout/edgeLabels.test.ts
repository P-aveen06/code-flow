import { describe, expect, it } from "vitest";
import type { Guard } from "../types";
import { placeEdgeLabels } from "./edgeLabels";
import type { FlowEdge, ModuleNode } from "./elk";

function box(id: string, x: number, y: number): ModuleNode {
  return { id, type: "module", position: { x, y }, width: 40, height: 40, data: { label: id } };
}

function call(id: string, source: string, target: string, when: Guard["when"], endX = 560): FlowEdge {
  return { id, source, target, data: {
    guard: { flag: "new_checkout", when }, status: "context", in_base: true, in_head: true,
    sections: [{
      id,
      startPoint: { x: 40, y: 0 },
      bendPoints: [{ x: 40, y: 40 }, { x: 200, y: 40 }],
      endPoint: { x: endX, y: 40 },
    }],
  } };
}

const nodes = [box("a", 0, 0), box("b", 560, 20), box("c", 500, 200)];

describe("placeEdgeLabels", () => {
  it("uses one representative edge per source and label, preserving every call guard", () => {
    const calls = [
      call("short", "a", "c", "on", 500),
      call("long", "a", "b", "on"),
      call("off", "a", "b", "off"),
      call("other-source", "c", "b", "on"),
    ];
    const { edges } = placeEdgeLabels(nodes, calls);
    expect(edges.map(({ label }) => label)).toEqual([
      undefined, "new_checkout: on", "new_checkout: off", "new_checkout: on",
    ]);
    expect(edges.map(({ data }) => data.guard)).toEqual(calls.map(({ data }) => data.guard));
    expect(edges[0].data.labelPlacement).toBeUndefined();
  });

  it("centres the label on the longest straight segment of the edge", () => {
    const { edges } = placeEdgeLabels(nodes, [call("long", "a", "b", "on")]);
    expect(edges[0].data.labelPlacement).toMatchObject({ center: { x: 300, y: 40 }, anchor: { x: 300, y: 40 } });
  });

  it("nudges labels away from a node box and from each other", () => {
    const blocker = box("obstacle", 280, 20);
    const { edges } = placeEdgeLabels([...nodes, blocker], [
      call("on", "a", "b", "on"),
      call("off", "a", "b", "off"),
    ]);
    const [on, off] = edges.map(({ data }) => data.labelPlacement!);
    const [a, b] = [on.bounds, off.bounds];
    for (const { anchor, center, bounds } of [on, off]) {
      expect(anchor).toEqual({ x: 300, y: 40 });
      expect(center).not.toEqual(anchor);
      expect(bounds.bottom <= 20 || bounds.top >= 60).toBe(true);
    }
    expect(a.bottom <= b.top || b.bottom <= a.top).toBe(true);
  });
});
