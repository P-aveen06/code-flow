import { describe, expect, it } from "vitest";
import { layoutFlow } from "../layout/elk";
import type { OverlayNode } from "../types";
import { nodeBounds } from "./fit";
import { applyLayoutPositions, layoutPositionKey, readLayoutPositions, writeLayoutPositions } from "./layoutPositions";
import { sideOf } from "./sides";

function sessionStorageFixture() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe("session layout positions", () => {
  it("scopes saved positions and reset to the repo, commit, variant and direction", () => {
    const storage = sessionStorageFixture();
    const key = layoutPositionKey("review-fixture", "head", "overlay_summary", "horizontal");
    const positions = new Map([["checkout", { x: -10, y: 120 }]]);
    writeLayoutPositions(key, positions, storage);
    expect(readLayoutPositions(key, storage)).toEqual(positions);
    expect(readLayoutPositions(layoutPositionKey("other", "head", "overlay_summary", "horizontal"), storage).size).toBe(0);
    expect(readLayoutPositions(layoutPositionKey("review-fixture", "other", "overlay_summary", "horizontal"), storage).size).toBe(0);
    const overlay = layoutPositionKey("review-fixture", "head", "overlay", "horizontal");
    const vertical = layoutPositionKey("review-fixture", "head", "overlay_summary", "vertical");
    expect(readLayoutPositions(overlay, storage).size).toBe(0);
    expect(readLayoutPositions(vertical, storage).size).toBe(0);
    writeLayoutPositions(overlay, positions, storage);
    writeLayoutPositions(vertical, positions, storage);
    writeLayoutPositions(key, new Map(), storage);
    expect(storage.getItem(key)).toBeNull();
    expect(readLayoutPositions(overlay, storage)).toEqual(positions);
    expect(readLayoutPositions(vertical, storage)).toEqual(positions);
  });

  it("reads legacy positions for horizontal layouts and clears them on reset", () => {
    const storage = sessionStorageFixture();
    const legacy = 'code-flow:layout:["review-fixture","head","overlay_summary"]';
    const horizontal = layoutPositionKey("review-fixture", "head", "overlay_summary", "horizontal");
    const vertical = layoutPositionKey("review-fixture", "head", "overlay_summary", "vertical");
    const positions = new Map([["checkout", { x: -10, y: 120 }]]);
    writeLayoutPositions(legacy, positions, storage);
    expect(readLayoutPositions(horizontal, storage)).toEqual(positions);
    expect(readLayoutPositions(vertical, storage).size).toBe(0);
    writeLayoutPositions(horizontal, new Map(), storage);
    expect(readLayoutPositions(horizontal, storage).size).toBe(0);
    expect(storage.getItem(legacy)).toBeNull();
  });

  it("ignores malformed data and tolerates blocked session storage", () => {
    const storage = sessionStorageFixture();
    storage.setItem("broken", "not JSON");
    expect(readLayoutPositions("broken", storage).size).toBe(0);
    storage.setItem("broken", '[null,["child",null],["other",{"x":0,"y":"bad"}]]');
    expect(readLayoutPositions("broken", storage).size).toBe(0);
    const denied = () => { throw new Error("Storage blocked"); };
    const blocked = { getItem: denied, setItem: denied, removeItem: denied };
    expect(readLayoutPositions("broken", blocked).size).toBe(0);
    expect(() => writeLayoutPositions("broken", new Map(), blocked)).not.toThrow();
  });
});

it("keeps vertical routes on bottom and top handles after dragging a symbol", async () => {
  const caller = symbol("caller", "cart");
  const callee = symbol("callee", "cart");
  const layout = await layoutFlow([caller, callee], [{
    source: caller.id, target: callee.id, status: "context", guard: null, in_base: true, in_head: true,
  }], [], false, "vertical");
  const moved = applyLayoutPositions(layout, new Map([[caller.id, { x: 240, y: 280 }]]), "vertical");
  const bounds = nodeBounds(moved.nodes);
  const source = bounds.get(caller.id)!;
  const target = bounds.get(callee.id)!;
  const [{ startPoint, endPoint }] = moved.edges[0].data.sections;
  expect(startPoint).toEqual({ x: source.x + source.width / 2, y: source.y + source.height });
  expect(endPoint).toEqual({ x: target.x + target.width / 2, y: target.y });
});

function symbol(id: string, module: string): OverlayNode {
  return {
    id, module, name: id, qualname: id, kind: "function", file: `${module}.py`, line: 1, end_line: 1,
    status: "changed", in_base: true, in_head: true,
    lines_added: 1, lines_removed: 1,
  };
}

it("shares symbol and module moves between comparison panes and updates their routes and labels", async () => {
  const checkout = symbol("checkout", "cart");
  const charge = symbol("charge", "payment");
  const layout = await layoutFlow([checkout, charge], [{
    source: checkout.id, target: charge.id, status: "context", guard: { flag: "new_checkout", when: "on" },
    in_base: true, in_head: true,
  }], [], true);
  const group = "module::cart";
  const modulePosition = { x: 80, y: 150 };
  const symbolPosition = { x: 230, y: 240 };
  const positions = new Map([[group, modulePosition], [charge.id, symbolPosition]]);
  const child = layout.nodes.find(({ id }) => id === checkout.id)!;

  for (const side of ["base", "head"] as const) {
    const moved = applyLayoutPositions(sideOf(layout, side), positions);
    const bounds = nodeBounds(moved.nodes);
    expect(moved.nodes.find(({ id }) => id === group)?.position).toEqual(modulePosition);
    expect(moved.nodes.find(({ id }) => id === charge.id)?.position).toEqual(symbolPosition);
    expect(bounds.get(checkout.id)).toMatchObject({
      x: modulePosition.x + child.position.x,
      y: modulePosition.y + child.position.y,
    });
    const { sections, labelPlacement } = moved.edges[0].data;
    expect(sections).not.toEqual(layout.edges[0].data.sections);
    expect(labelPlacement?.anchor).not.toEqual(layout.edges[0].data.labelPlacement?.anchor);
  }

  expect(layout.edges[0].data.sections.length).toBeGreaterThan(0);
  expect(applyLayoutPositions(layout, new Map())).toBe(layout);
});
