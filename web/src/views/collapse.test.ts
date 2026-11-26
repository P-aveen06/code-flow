import { describe, expect, it } from "vitest";
import type { NodeStatus, OverlayEdge, OverlayNode } from "../types";
import { collapseContext } from "./collapse";

function symbol(name: string, module: string, status: NodeStatus = "context"): OverlayNode {
  return {
    id: `${module}:${name}`, name, qualname: name, module, status, kind: "function",
    file: `${module}.py`, line: 1, end_line: 5, in_base: status !== "added", in_head: status !== "removed",
    lines_added: 0, lines_removed: 0,
  };
}

function call(
  source: OverlayNode, target: OverlayNode, status: OverlayEdge["status"] = "context",
  guard: OverlayEdge["guard"] = null,
): OverlayEdge {
  return {
    source: source.id, target: target.id, status, guard, in_base: status !== "added", in_head: status !== "removed",
  };
}

const changed = symbol("run", "api", "changed");
const added = symbol("new_path", "api", "added");
const removed = symbol("old_path", "api", "removed");
const callee = symbol("send", "services");
const caller = symbol("notify", "services");
const guardedFrom = symbol("legacy", "services");
const guardedTo = symbol("query", "database");
const first = symbol("first", "services");
const second = symbol("second", "services");
const other = symbol("setup", "database");

describe("collapseContext", () => {
  it("keeps all changes, changed call endpoints next to a change, and both endpoints of guarded calls", () => {
    const nodes = [changed, added, removed, callee, caller, guardedFrom, guardedTo, first, second, other];
    const edges = [
      call(added, callee, "added"),
      call(caller, removed, "removed"),
      call(guardedFrom, guardedTo, "context", { flag: "legacy", when: "on" }),
      call(changed, first),
    ];
    const graph = collapseContext(nodes, edges, new Set());
    expect(graph.nodes).toEqual(nodes.slice(0, 7));
    expect(graph.chips).toEqual([
      { id: "context::services", module: "services", count: 2, in_base: true, in_head: true },
      { id: "context::database", module: "database", count: 1, in_base: true, in_head: true },
    ]);
    expect(graph.edges).toEqual([...edges.slice(0, 3), { ...edges[3], target: "context::services" }]);
  });

  it("deduplicates redirected calls in both directions and retains distinct statuses", () => {
    const edges = [
      call(changed, first), call(changed, second),
      call(first, changed), call(second, changed),
      call(first, second), call(changed, changed),
      call(first, other, "added"), call(second, other, "removed"),
    ];
    const graph = collapseContext([changed, first, second, other], edges, new Set());
    expect(graph.edges).toEqual([
      { ...edges[0], target: "context::services" },
      { ...edges[2], source: "context::services" },
      edges[5],
      { ...edges[6], source: "context::services", target: "context::database" },
      { ...edges[7], source: "context::services", target: "context::database" },
    ]);
    expect(edges[0].target).toBe(first.id);
  });

  it("expands one module or restores the original neighbourhood", () => {
    const nodes = [changed, first, second, other];
    const edges = [call(changed, first), call(first, second), call(other, second)];
    const expanded = collapseContext(nodes, edges, new Set(["services"]));
    expect(expanded.nodes).toEqual([changed, first, second]);
    expect(expanded.chips.map(({ module }) => module)).toEqual(["database"]);
    expect(expanded.edges).toEqual([...edges.slice(0, 2), { ...edges[2], source: "context::database" }]);
    expect(collapseContext(nodes, edges, "all")).toEqual({ nodes, edges, chips: [] });
  });
});
