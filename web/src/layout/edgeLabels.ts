import type { Rect } from "@xyflow/react";
import type { ElkEdgeSection, ElkPoint } from "elkjs/lib/elk.bundled.js";
import type { FlowEdge, FlowNode } from "./elk";

interface Box { left: number; right: number; top: number; bottom: number }
export interface LabelPlacement { center: ElkPoint; anchor: ElkPoint; bounds: Box }

// Match the small monospace badge, with room for padding, border, and a gap.
const labelHalfHeight = 11;
const labelGap = 4;

export function routePoints({ startPoint, bendPoints = [], endPoint }: ElkEdgeSection) {
  return [startPoint, ...bendPoints, endPoint].filter((point, index, points) => {
    const previous = points[index - 1];
    return !previous || point.x !== previous.x || point.y !== previous.y;
  });
}

function boxAt({ x, y }: ElkPoint, halfWidth: number): Box {
  return { left: x - halfWidth, right: x + halfWidth, top: y - labelHalfHeight, bottom: y + labelHalfHeight };
}

function overlaps(a: Box, b: Box) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function labelPlacement(routes: ElkPoint[][], boxes: Box[], halfWidth: number): LabelPlacement | undefined {
  const anchors = routes.flatMap((points) => points.flatMap((start, index) => {
    const end = points[index + 1];
    return end ? [0.5, 0.25, 0.75].map((part) => ({
      x: start.x + (end.x - start.x) * part, y: start.y + (end.y - start.y) * part,
    })) : [start];
  }));
  let best: LabelPlacement | undefined;
  let leastDistance = Infinity;

  for (const anchor of anchors) {
    // Try the route first, then the gaps just outside nearby boxes or labels.
    const candidates = [anchor];
    for (const box of boxes) {
      candidates.push(
        { x: anchor.x, y: box.top - labelHalfHeight - labelGap },
        { x: anchor.x, y: box.bottom + labelHalfHeight + labelGap },
        { x: box.left - halfWidth - labelGap, y: anchor.y },
        { x: box.right + halfWidth + labelGap, y: anchor.y },
      );
    }
    for (const center of candidates) {
      const distance = Math.hypot(center.x - anchor.x, center.y - anchor.y);
      const bounds = boxAt(center, halfWidth);
      if (distance >= leastDistance || boxes.some((box) => overlaps(bounds, box))) continue;
      best = { center, anchor, bounds };
      leastDistance = distance;
    }
    if (leastDistance === 0) break;
  }
  return best;
}

export function placeEdgeLabels(nodes: FlowNode[], edges: FlowEdge[]) {
  const positions = new Map(nodes.map(({ id, position }) => [id, position]));
  const byId = new Map<string, Box>();
  const obstacles: Box[] = [];
  for (const { id, hidden, parentId, position, width = 0, height = 0 } of nodes) {
    if (hidden) continue;
    const parent = parentId ? positions.get(parentId) : undefined;
    const left = position.x + (parent?.x ?? 0);
    const top = position.y + (parent?.y ?? 0);
    const box = { left, top, right: left + width, bottom: top + height };
    byId.set(id, box);
    if (!parentId) obstacles.push(box);
  }

  const labels = new Map<string, LabelPlacement>();
  for (const { id, label, source, target, data } of edges) {
    if (!label) continue;
    const from = byId.get(source);
    const to = byId.get(target);
    if (!from || !to) continue;
    const routes = data.sections.length ? data.sections.map(routePoints) : [[
      { x: from.right, y: (from.top + from.bottom) / 2 },
      { x: to.left, y: (to.top + to.bottom) / 2 },
    ]];
    // Reserve room for the live state suffix so refreshing a flag keeps the layout steady.
    const halfWidth = ((label.length + " · LIVE".length) * 7.5 + 18) / 2;
    const placement = labelPlacement(routes, obstacles, halfWidth);
    if (placement) {
      labels.set(id, placement);
      obstacles.push(boxAt(placement.center, halfWidth + labelGap));
    }
  }
  return labels;
}

export function edgeLabelBounds(placements: ReadonlyMap<string, LabelPlacement>): Rect | undefined {
  if (!placements.size) return undefined;
  const boxes = [...placements.values()].map(({ bounds }) => bounds);
  const x = Math.min(...boxes.map(({ left }) => left));
  const y = Math.min(...boxes.map(({ top }) => top));
  return {
    x, y,
    width: Math.max(...boxes.map(({ right }) => right)) - x,
    height: Math.max(...boxes.map(({ bottom }) => bottom)) - y,
  };
}
