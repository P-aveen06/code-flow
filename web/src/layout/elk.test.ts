import { describe, expect, it } from "vitest";
import type { OverlayEdge, OverlayNode } from "../types";
import { diagramFit, nodeBounds } from "../views/fit";
import { flowHandlePositions } from "../views/FlowCanvas";
import { routePoints } from "./edgeLabels";
import { ELK_OPTIONS, layoutFlow } from "./elk";

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

function expectVerticalRoutes(layout: Awaited<ReturnType<typeof layoutFlow>>) {
  const boxes = nodeBounds(layout.nodes);
  for (const edge of layout.edges) {
    const source = boxes.get(edge.source)!;
    const target = boxes.get(edge.target)!;
    const sections = edge.data.sections;
    const { startPoint } = sections.find(({ incomingSections }) => !incomingSections?.length)!;
    const { endPoint } = sections.find(({ outgoingSections }) => !outgoingSections?.length)!;
    expect(startPoint.x).toBeCloseTo(source.x + source.width / 2);
    expect(startPoint.y).toBeCloseTo(source.y + source.height);
    expect(endPoint.x).toBeCloseTo(target.x + target.width / 2);
    expect(endPoint.y).toBeCloseTo(target.y);
    for (const section of sections) {
      const points = routePoints(section);
      points.slice(1).forEach(({ x, y }, index) => {
        const prior = points[index];
        expect(x === prior.x || y === prior.y).toBe(true);
      });
    }
  }
}

describe("layoutFlow", () => {
  it("reserves room between symbols, between disconnected modules and above the module's first row", async () => {
    const layout = await layoutFlow(nodes, [edges[0]]);
    const checkoutGroup = layout.nodes.find(({ id }) => id === "module::checkout")!;
    const paymentGroup = layout.nodes.find(({ id }) => id === "module::payment")!;
    const first = layout.nodes.find(({ id }) => id === checkout.id)!;
    const second = layout.nodes.find(({ id }) => id === validate.id)!;
    expect(first.position.x).toBeGreaterThanOrEqual(24);
    expect(first.position.y).toBeGreaterThanOrEqual(48);
    expect(second.position.x - first.position.x - first.width!).toBeGreaterThanOrEqual(
      Number(ELK_OPTIONS.layeredSpacing["elk.layered.spacing.nodeNodeBetweenLayers"]),
    );

    const [left, right] = [checkoutGroup, paymentGroup].sort((a, b) => a.position.x - b.position.x);
    const [top, bottom] = [checkoutGroup, paymentGroup].sort((a, b) => a.position.y - b.position.y);
    const gap = Math.max(right.position.x - left.position.x - left.width!, bottom.position.y - top.position.y - top.height!);
    expect(gap).toBeGreaterThanOrEqual(Number(ELK_OPTIONS.layeredSpacing["elk.spacing.componentComponent"]));
  });

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

  it("keeps short cards compact and makes room to wrap a long name", async () => {
    const longName = symbol("checkout", "charge_payment_after_running_validation");
    const { nodes: symbols } = await layoutFlow([checkout, longName], []);
    const short = symbols.find(({ id }) => id === checkout.id)!;
    const wrapped = symbols.find(({ id }) => id === longName.id)!;

    expect(short.width).toBe(140);
    expect(wrapped.width!).toBeLessThan(longName.qualname.length * 10.2);
    expect(wrapped.height!).toBeGreaterThan(short.height!);
  });

  it("routes calls to a context chip and keeps module-only chips small", async () => {
    const chip = { id: "context::pricing", module: "pricing", count: 3, in_base: true, in_head: true };
    const layout = await layoutFlow([checkout], [{ ...edges[0], target: chip.id }], [chip]);
    const packed = layout.nodes.find(({ id }) => id === chip.id)!;
    expect(packed).toMatchObject({ type: "context", data: { chip, label: "+3 unchanged in pricing" } });
    expect(packed.parentId).toBeUndefined();
    expect(packed.height!).toBeLessThan(layout.nodes.find(({ id }) => id === checkout.id)!.height!);
    expect(layout.edges[0].data.sections.length).toBeGreaterThan(0);
  });

  it("packs a wide comparison while still connecting the actual symbols", async () => {
    const chain = Array.from({ length: 7 }, (_, index): OverlayNode => ({
      ...symbol(`module_${index}`, "process_transaction"), status: "changed",
    }));
    const calls = chain.slice(1).map((node, index) => ({
      ...edges[0], source: chain[index].id, target: node.id,
    }));
    const layout = await layoutFlow(chain, calls, [], true);
    const groups = layout.nodes.filter(({ type }) => type === "module");
    expect(new Set(groups.map(({ position }) => position.y)).size).toBeGreaterThan(1);

    for (const edge of layout.edges) {
      const target = layout.nodes.find(({ id }) => id === edge.target)!;
      const group = groups.find(({ id }) => id === target.parentId)!;
      const { endPoint } = edge.data.sections[0];
      const left = group.position.x + target.position.x;
      expect([left, left + target.width!]).toContain(endPoint.x);
      expect(endPoint.y).toBe(group.position.y + target.position.y + target.height! / 2);
    }
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

  it("keeps long guard labels outside module boxes and within the fit bounds", async () => {
    const guard = { flag: "get_current_api_usage_deprecated", when: "on" } as const;
    const calls = [
      { ...edges[0], guard },
      { ...edges[1], guard },
    ];
    const layout = await layoutFlow(nodes, calls, [], true);
    const modules = layout.nodes.filter(({ type }) => type === "module");
    const labels = layout.edges.map(({ data }) => data.labelPlacement!.bounds);
    const container = layout.labelBounds!;

    for (const label of labels) {
      expect(label.left).toBeGreaterThanOrEqual(container.x);
      expect(label.top).toBeGreaterThanOrEqual(container.y);
      expect(label.right).toBeLessThanOrEqual(container.x + container.width);
      expect(label.bottom).toBeLessThanOrEqual(container.y + container.height);
      for (const { position, width = 0, height = 0 } of modules) {
        const outside = label.right <= position.x || label.left >= position.x + width
          || label.bottom <= position.y || label.top >= position.y + height;
        expect(outside).toBe(true);
      }
    }

    const [a, b] = labels;
    expect(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom).toBe(true);
  });

  it("is deterministic and accepts an empty graph", async () => {
    expect(await layoutFlow(nodes, edges)).toEqual(await layoutFlow(nodes, edges));
    expect(await layoutFlow([], [])).toEqual({ nodes: [], edges: [] });
  });

  it("keeps default horizontal geometry and left/right handles", async () => {
    expect(await layoutFlow(nodes, edges, [], false, "horizontal")).toEqual(await layoutFlow(nodes, edges));
    expect(flowHandlePositions("horizontal")).toEqual({ sourcePosition: "right", targetPosition: "left" });
  });

  it("flows downward through symbols and chips, with top/bottom handles, spacing and guard labels", async () => {
    const chip = { id: "context::pricing", module: "pricing", count: 3, in_base: true, in_head: true };
    const layout = await layoutFlow(nodes, [...edges, { ...edges[0], source: charge.id, target: chip.id }], [chip], false, "vertical");
    const boxes = nodeBounds(layout.nodes);
    const chain = [checkout.id, validate.id, charge.id, chip.id].map((id) => boxes.get(id)!);
    for (let index = 1; index < chain.length; index++) {
      const previous = chain[index - 1];
      expect(chain[index].y - previous.y - previous.height).toBeGreaterThanOrEqual(
        Number(ELK_OPTIONS.layeredSpacing["elk.layered.spacing.nodeNodeBetweenLayers"]),
      );
    }
    expectVerticalRoutes(layout);
    expect(flowHandlePositions("vertical")).toEqual({ sourcePosition: "bottom", targetPosition: "top" });
    expect(layout.edges[1].label).toBe("new_checkout: on");
    expect(layout.labelBounds).toBeDefined();

    const { x, y, zoom } = diagramFit(layout, 750, 500, "bottom-right", false)!;
    for (const box of [...boxes.values(), layout.labelBounds!]) {
      expect(box.x * zoom + x).toBeGreaterThanOrEqual(0);
      expect(box.y * zoom + y).toBeGreaterThanOrEqual(0);
      expect((box.x + box.width) * zoom + x).toBeLessThanOrEqual(750);
      expect((box.y + box.height) * zoom + y).toBeLessThanOrEqual(500);
    }
  });

  it("keeps packed comparison and recursive routes on the vertical handles", async () => {
    const chain = Array.from({ length: 9 }, (_, index): OverlayNode => ({
      ...symbol(`module_${index}`, "validate_payment"), status: "changed",
    }));
    const calls = chain.slice(1).map((node, index) => ({
      ...edges[0], source: chain[index].id, target: node.id,
    }));
    calls.push({ ...edges[0], source: chain[0].id, target: chain[0].id });
    const layout = await layoutFlow(chain, calls, [], true, "vertical");
    const groups = layout.nodes.filter(({ type }) => type === "module");
    expect(new Set(groups.map(({ position }) => position.x)).size).toBeGreaterThan(1);
    expectVerticalRoutes(layout);
  });
});
