import { describe, expect, it } from "vitest";
import type { OverlayEdge, OverlayNode } from "../types";
import { layoutFlow } from "./elk";

function symbol(module: string, name: string): OverlayNode {
  return {
    id: `${module}:${name}`,
    name,
    qualname: name,
    kind: "function",
    module,
    file: `${module}.py`,
    line: 1,
    end_line: 5,
    status: "context",
    in_base: true,
    in_head: true,
  };
}

const checkout = symbol("checkout", "checkout");
const validate = symbol("checkout", "validate");
const charge = symbol("payment", "charge_payment_after_validation");
const nodes = [checkout, validate, charge];
const edges: OverlayEdge[] = [
  { source: checkout.id, target: validate.id, status: "context", guard: null, in_base: true, in_head: true },
  {
    source: validate.id,
    target: charge.id,
    status: "added",
    guard: { flag: "new_checkout", when: "on" },
    in_base: false,
    in_head: true,
  },
];

describe("layoutFlow", () => {
  it("groups every symbol inside its module and lays out calls left to right", async () => {
    const layout = await layoutFlow(nodes, edges);
    const groups = layout.nodes.filter((node) => node.type === "module");
    const symbols = layout.nodes.filter((node) => node.type === "symbol");
    expect(groups.map(({ data }) => data.label)).toEqual(["checkout", "payment"]);
    expect(symbols.map(({ id }) => id).sort()).toEqual(nodes.map(({ id }) => id).sort());

    for (const node of symbols) {
      const parent = groups.find(({ id }) => id === node.parentId)!;
      expect(parent.data.label).toBe(node.data.symbol.module);
      expect(layout.nodes.indexOf(parent)).toBeLessThan(layout.nodes.indexOf(node));
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
      expect(node.position.x + node.width!).toBeLessThanOrEqual(parent.width!);
      expect(node.position.y + node.height!).toBeLessThanOrEqual(parent.height!);
    }

    const first = symbols.find(({ id }) => id === checkout.id)!;
    const last = symbols.find(({ id }) => id === charge.id)!;
    expect(last.width!).toBeGreaterThan(first.width!);
    expect(groups[1].position.x + last.position.x).toBeGreaterThan(groups[0].position.x + first.position.x);
  });

  it("widens a short symbol when its hint needs more room", async () => {
    const changedCheckout: OverlayNode = { ...checkout, status: "changed" };
    const shortMethod: OverlayNode = { ...validate, kind: "method", status: "added" };
    const { nodes: symbols } = await layoutFlow([changedCheckout, shortMethod], []);

    expect(symbols.find(({ id }) => id === shortMethod.id)?.width).toBe(140);
    expect(symbols.find(({ id }) => id === changedCheckout.id)?.width).toBeGreaterThan(140);
  });

  it("keeps internal and cross-module edges, including guard information", async () => {
    const layout = await layoutFlow(nodes, edges);
    expect(layout.edges).toHaveLength(edges.length);
    expect(layout.edges).toMatchObject(
      edges.map(({ source, target, ...data }) => ({ source, target, data })),
    );
  });

  it("keeps guard labels and root-relative orthogonal routes", async () => {
    const layout = await layoutFlow(nodes, edges);
    expect(layout.edges.map(({ label }) => label)).toEqual([undefined, "new_checkout: on"]);

    for (const edge of layout.edges) {
      expect(edge.data.sections.length).toBeGreaterThan(0);
      for (const { startPoint, bendPoints = [], endPoint } of edge.data.sections) {
        const points = [startPoint, ...bendPoints, endPoint];
        for (let index = 1; index < points.length; index++) {
          const previous = points[index - 1];
          const current = points[index];
          expect(previous.x === current.x || previous.y === current.y).toBe(true);
        }
      }

      const source = layout.nodes.find(({ id }) => id === edge.source)!;
      const module = layout.nodes.find(({ id }) => id === source.parentId)!;
      const { startPoint } = edge.data.sections[0];
      expect(startPoint.x).toBeCloseTo(module.position.x + source.position.x + source.width!);
      expect(startPoint.y).toBeCloseTo(module.position.y + source.position.y + source.height! / 2);
    }
  });

  it("is deterministic and accepts an empty graph", async () => {
    expect(await layoutFlow(nodes, edges)).toEqual(await layoutFlow(nodes, edges));
    expect(await layoutFlow([], [])).toEqual({ nodes: [], edges: [] });
  });
});
