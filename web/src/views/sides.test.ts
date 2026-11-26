import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowLayout, ModuleNode, SymbolNode } from "../layout/elk";
import type { NodeStatus } from "../types";
import { sideOf } from "./sides";

function symbol(id: string, parentId: string, status: NodeStatus, x: number): SymbolNode {
  return {
    id,
    parentId,
    type: "symbol",
    position: { x, y: 20 },
    data: {
      symbol: {
        id,
        name: id,
        qualname: id,
        module: parentId,
        kind: "function",
        file: `${parentId}.py`,
        line: 1,
        end_line: 5,
        status,
        in_base: status !== "added",
        in_head: status !== "removed",
      },
    },
  };
}

function edge(source: string, target: string, in_base: boolean, in_head: boolean): FlowEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    data: {
      in_base,
      in_head,
      status: in_base && in_head ? "context" : in_base ? "removed" : "added",
      guard: null,
      sections: [],
      labelWidth: 0,
    },
  };
}

const checkout: ModuleNode = { id: "checkout", type: "module", position: { x: 10, y: 10 }, data: { label: "checkout" } };
const payment: ModuleNode = { id: "payment", type: "module", position: { x: 300, y: 10 }, data: { label: "payment" } };
const shared = symbol("shared", "checkout", "changed", 20);
const context = symbol("context", "checkout", "context", 200);
const removed = symbol("removed", "checkout", "removed", 200);
const added = symbol("added", "payment", "added", 40);
const both = edge(shared.id, context.id, true, true);
const baseOnly = edge(context.id, shared.id, true, false);
const headOnly = edge(shared.id, added.id, false, true);
const missingOnBase = edge(added.id, shared.id, true, true);
const missingOnHead = edge(shared.id, removed.id, true, true);
const layout: FlowLayout = {
  nodes: [checkout, shared, context, removed, payment, added],
  edges: [both, baseOnly, headOnly, missingOnBase, missingOnHead],
};

describe("sideOf", () => {
  it("filters each revision and keeps the shared node positions", () => {
    const base = sideOf(layout, "base");
    const head = sideOf(layout, "head");
    expect(base.nodes).toEqual([checkout, shared, context, removed]);
    expect(head.nodes).toEqual([checkout, shared, context, payment, added]);
    expect(base.nodes[1].position).toBe(head.nodes[1].position);
  });

  it("checks both edge membership and the presence of both endpoints", () => {
    expect(sideOf(layout, "base").edges).toEqual([both, baseOnly, missingOnHead]);
    expect(sideOf(layout, "head").edges).toEqual([both, headOnly, missingOnBase]);
  });
});
