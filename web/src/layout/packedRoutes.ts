import type { ElkEdgeSection } from "elkjs/lib/elk.bundled.js";
import type { FlowEdge, FlowNode } from "./elk";

function box(node: FlowNode, parent?: FlowNode) {
  const x = node.position.x + (parent?.position.x ?? 0);
  const y = node.position.y + (parent?.position.y ?? 0);
  return { left: x, right: x + (node.width ?? 0), middle: y + (node.height ?? 0) / 2 };
}

// Calls that ELK did not route use the gap between modules or pass around
// one side when the modules are stacked.
export function packedRoutes(nodes: FlowNode[], edges: FlowEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const routes = new Map<string, ElkEdgeSection[]>();
  const lanes = new Map<string, number>();

  for (const { id, source, target } of edges) {
    const from = byId.get(source);
    const to = byId.get(target);
    if (!from || !to || source === target) continue;

    const fromParent = from.parentId ? byId.get(from.parentId) : undefined;
    const toParent = to.parentId ? byId.get(to.parentId) : undefined;
    const a = box(from, fromParent);
    const b = box(to, toParent);
    const aGroup = fromParent ? box(fromParent) : a;
    const bGroup = toParent ? box(toParent) : b;
    const pair = JSON.stringify([fromParent?.id ?? source, toParent?.id ?? target].sort());
    const index = lanes.get(pair) ?? 0;
    lanes.set(pair, index + 1);
    const offset = (index % 5 - 2) * 3;

    let start = a.right;
    let end = b.right;
    let lane = Math.max(aGroup.right, bGroup.right) + 12 + offset;
    if (aGroup.right < bGroup.left) {
      end = b.left;
      lane = (aGroup.right + bGroup.left) / 2 + offset;
    } else if (bGroup.right < aGroup.left) {
      start = a.left;
      lane = (bGroup.right + aGroup.left) / 2 + offset;
    }
    routes.set(id, [{
      id,
      startPoint: { x: start, y: a.middle },
      bendPoints: [{ x: lane, y: a.middle }, { x: lane, y: b.middle }],
      endPoint: { x: end, y: b.middle },
    }]);
  }
  return routes;
}
