import type { Rect, Viewport } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowLayout, FlowNode, SymbolNode } from "../layout/elk";
import { diagramFit, includeLabelBounds, nodeBounds } from "./fit";

function symbol(id: string, x: number, status: "changed" | "context" = "context"): SymbolNode {
  return {
    id, type: "symbol", position: { x, y: 0 }, width: 140, height: 36,
    data: { symbol: {
      id, status, name: id, qualname: id, module: "example", kind: "function", file: "example.py",
      line: 1, end_line: 1, in_base: true, in_head: true,
    } },
  };
}

function call(source: string, target: string): FlowEdge {
  return { id: `${source}-${target}`, source, target, data: {
    status: "context", guard: null, in_base: true, in_head: true, sections: [],
  } };
}

const width = 650;
const height = 400;

function expectInside(box: Rect, viewport: Viewport, canvasWidth = width, canvasHeight = height) {
  const { x, y, zoom } = viewport;
  const epsilon = 1e-6;
  expect(x + box.x * zoom).toBeGreaterThanOrEqual(-epsilon);
  expect(y + box.y * zoom).toBeGreaterThanOrEqual(-epsilon);
  expect(x + (box.x + box.width) * zoom).toBeLessThanOrEqual(canvasWidth + epsilon);
  expect(y + (box.y + box.height) * zoom).toBeLessThanOrEqual(canvasHeight + epsilon);
}

describe("diagramFit", () => {
  it("fits all visible nodes when the whole diagram is readable", () => {
    const layout = { nodes: [symbol("one", -40, "changed"), symbol("two", 440)], edges: [] };
    const viewport = diagramFit(layout, width, height, "bottom-right")!;
    expect(viewport.zoom).toBeGreaterThanOrEqual(0.65);
    for (const box of nodeBounds(layout.nodes).values()) expectInside(box, viewport);
  });

  it("focuses on the change and its callers and callees, and can fit distant context too", () => {
    const layout: FlowLayout = {
      nodes: [symbol("caller", 0), symbol("changed", 250, "changed"), symbol("callee", 500), symbol("distant", 2400)],
      edges: [call("caller", "changed"), call("changed", "callee"), call("callee", "distant")],
      labelBounds: { x: 1500, y: -150, width: 300, height: 22 },
    };
    const boxes = nodeBounds(layout.nodes);
    const focus = diagramFit(layout, width, height, "bottom-right")!;
    const all = diagramFit(layout, width, height, "bottom-right", false)!;
    expect(focus.zoom).toBeGreaterThanOrEqual(0.65);
    expect(focus.zoom).toBeGreaterThan(all.zoom);
    for (const node of layout.nodes.slice(0, 3)) expectInside(boxes.get(node.id)!, focus);
    for (const box of boxes.values()) expectInside(box, all);
    expectInside(layout.labelBounds!, all);
  });

  it("fits a direct neighbour in the far-right column even when zoom must drop below the readable minimum", () => {
    const layout = {
      nodes: [symbol("changed", 0, "changed"), symbol("callee", 1800), symbol("distant", 6400)],
      edges: [call("changed", "callee")],
    };
    const viewport = diagramFit(layout, width, height, "top-right")!;
    expect(viewport.zoom).toBeLessThan(0.65);
    const boxes = nodeBounds(layout.nodes);
    expectInside(boxes.get("changed")!, viewport);
    expectInside(boxes.get("callee")!, viewport);
    expect(viewport.x + boxes.get("distant")!.x * viewport.zoom).toBeGreaterThan(width);
  });

  it("shifts the readable viewport to keep nearby context boxes whole", () => {
    const layout = {
      nodes: [symbol("changed", 200, "changed"), symbol("straddlesRightEdge", 510), symbol("distant", 2200)],
      edges: [],
    };
    const viewport = diagramFit(layout, width, height, "bottom-right")!;
    const boxes = nodeBounds(layout.nodes);
    expect(viewport.zoom).toBeGreaterThanOrEqual(0.65);
    expectInside(boxes.get("changed")!, viewport);
    expectInside(boxes.get("straddlesRightEdge")!, viewport);
    expect(viewport.x + boxes.get("distant")!.x * viewport.zoom).toBeGreaterThan(width);
  });

  it("uses less padding when the focused boxes just fit at the readable zoom", () => {
    const layout = {
      nodes: [symbol("changed", 0, "changed"), symbol("callee", 860), symbol("distant", 2200)],
      edges: [call("changed", "callee")],
    };
    const viewport = diagramFit(layout, width, height, "bottom-right")!;
    expect(viewport.zoom).toBe(0.65);
    for (const box of nodeBounds(layout.nodes.slice(0, 2)).values()) expectInside(box, viewport);
  });

  it("uses the boxes of changed symbols and their neighbours inside large modules", () => {
    const nodes: FlowNode[] = [
      { id: "group", type: "module", position: { x: 100, y: 50 }, width: 3000, height: 160, data: { label: "example" } },
      { ...symbol("changed", 300, "changed"), parentId: "group" },
      { ...symbol("callee", 700), parentId: "group" },
    ];
    const viewport = diagramFit({ nodes, edges: [call("changed", "callee")] }, width, height, "bottom-right")!;
    expect(viewport.zoom).toBeGreaterThanOrEqual(0.65);
    const boxes = nodeBounds(nodes);
    expectInside(boxes.get("changed")!, viewport);
    expectInside(boxes.get("callee")!, viewport);
  });

  it("fits very wide diagrams without a minimum zoom cutting off their edges", () => {
    const layout = {
      nodes: [symbol("changed", 0, "changed"), symbol("callee", 20_000)],
      edges: [call("changed", "callee")],
    };
    const viewport = diagramFit(layout, width, height, "bottom-right")!;
    expect(viewport.zoom).toBeLessThan(0.06);
    for (const box of nodeBounds(layout.nodes).values()) expectInside(box, viewport);
  });

  it("also fits flag badges beyond the diagram", () => {
    const labelBounds = { x: 120, y: -48, width: 720, height: 90 };
    const layout = { nodes: [symbol("changed", 0, "changed")], edges: [], labelBounds };
    expectInside(labelBounds, diagramFit(layout, width, height, "bottom-right", false)!);
    expect(includeLabelBounds({ x: 0, y: 0, width: 700, height: 500 }, labelBounds))
      .toEqual({ x: 0, y: -48, width: 840, height: 548 });
  });

  it("includes routed edges that extend beyond the node boxes in Fit view", () => {
    const edge = call("caller", "callee");
    const bend = { x: 900, y: 18 };
    edge.data.sections = [{ id: edge.id, startPoint: { x: 140, y: 18 }, bendPoints: [bend], endPoint: { x: 280, y: 18 } }];
    const layout = { nodes: [symbol("caller", 0), symbol("callee", 280)], edges: [edge] };
    const viewport = diagramFit(layout, width, height, "bottom-right", false)!;
    expectInside({ ...bend, width: 0, height: 0 }, viewport);
  });
});

it("includes a visible child in absolute coordinates, even outside its moved module", () => {
  const nodes: FlowNode[] = [
    { id: "group", type: "module", position: { x: -500, y: 60 }, width: 250, height: 160, data: { label: "example" } },
    { ...symbol("child", -200), parentId: "group" },
    { ...symbol("hidden", 10_000), hidden: true },
  ];
  const bounds = nodeBounds(nodes);
  expect(bounds.get("child")).toEqual({ x: -700, y: 60, width: 140, height: 36 });
  expect(bounds.has("hidden")).toBe(false);
  const viewport = diagramFit({ nodes, edges: [] }, width, height, "bottom-right")!;
  for (const box of bounds.values()) expectInside(box, viewport);
});
