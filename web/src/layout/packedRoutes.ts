import type { ElkEdgeSection } from "elkjs/lib/elk.bundled.js";
import type { FlowDirection } from "../view";
import type { FlowEdge, FlowNode } from "./elk";

const groupClearance = 24;
const laneSpacing = 6;

function box(node: FlowNode, vertical: boolean, parent?: FlowNode) {
  const x = node.position.x + (parent?.position.x ?? 0);
  const y = node.position.y + (parent?.position.y ?? 0);
  const width = node.width ?? 0;
  const height = node.height ?? 0;
  return vertical
    ? { start: y, end: y + height, side: x, breadth: width }
    : { start: x, end: x + width, side: y, breadth: height };
}

// Calls that ELK did not route use the gap between modules or pass around
// one side when the modules are stacked.
export function packedRoutes(nodes: FlowNode[], edges: FlowEdge[], direction: FlowDirection = "horizontal") {
  const vertical = direction === "vertical";
  const point = (along: number, across: number) => vertical ? { x: across, y: along } : { x: along, y: across };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const routes = new Map<string, ElkEdgeSection[]>();
  const lanes = new Map<string, number>();

  for (const { id, source, target } of edges) {
    const from = byId.get(source);
    const to = byId.get(target);
    if (!from || !to) continue;

    const fromParent = from.parentId ? byId.get(from.parentId) : undefined;
    const toParent = to.parentId ? byId.get(to.parentId) : undefined;
    const a = box(from, vertical, fromParent);
    const b = box(to, vertical, toParent);
    const aMiddle = a.side + a.breadth / 2;
    const bMiddle = b.side + b.breadth / 2;
    if (source === target) {
      const after = a.end + groupClearance;
      const before = a.start - groupClearance;
      const outside = a.side - groupClearance;
      routes.set(id, [{
        id,
        startPoint: point(a.end, aMiddle),
        bendPoints: [point(after, aMiddle), point(after, outside), point(before, outside), point(before, aMiddle)],
        endPoint: point(a.start, aMiddle),
      }]);
      continue;
    }
    const aGroup = fromParent ? box(fromParent, vertical) : a;
    const bGroup = toParent ? box(toParent, vertical) : b;
    const pair = JSON.stringify([fromParent?.id ?? source, toParent?.id ?? target].sort());
    const index = lanes.get(pair) ?? 0;
    lanes.set(pair, index + 1);
    const offset = (index % 5 - 2) * laneSpacing;

    const sourceEnd = Math.max(aGroup.end, a.end);
    const targetStart = Math.min(bGroup.start, b.start);
    if (vertical && sourceEnd >= targetStart) {
      // A wrapped or backward call still leaves the bottom and enters the top.
      const after = sourceEnd + groupClearance + offset;
      const before = targetStart - groupClearance - offset;
      const side = Math.max(
        aGroup.side + aGroup.breadth, bGroup.side + bGroup.breadth, a.side + a.breadth, b.side + b.breadth,
      ) + groupClearance + offset;
      routes.set(id, [{
        id,
        startPoint: point(a.end, aMiddle),
        bendPoints: [point(after, aMiddle), point(after, side), point(before, side), point(before, bMiddle)],
        endPoint: point(b.start, bMiddle),
      }]);
      continue;
    }

    let start = a.end;
    let end = b.end;
    let lane = Math.max(aGroup.end, bGroup.end) + groupClearance + offset;
    if (vertical) {
      end = b.start;
      lane = (sourceEnd + targetStart) / 2 + offset;
    } else if (aGroup.end < bGroup.start) {
      end = b.start;
      lane = (aGroup.end + bGroup.start) / 2 + offset;
    } else if (bGroup.end < aGroup.start) {
      start = a.start;
      lane = (bGroup.end + aGroup.start) / 2 + offset;
    }
    routes.set(id, [{
      id,
      startPoint: point(start, aMiddle),
      bendPoints: [point(lane, aMiddle), point(lane, bMiddle)],
      endPoint: point(end, bMiddle),
    }]);
  }
  return routes;
}
