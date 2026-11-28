import type { Rect } from "@xyflow/react";
import type { ElkEdgeSection, ElkPoint } from "elkjs/lib/elk.bundled.js";
import type { FlowEdge, FlowNode } from "./elk";
import { guardLabel } from "../views/styles";

interface Box { left: number; right: number; top: number; bottom: number }
export interface LabelPlacement { center: ElkPoint; anchor: ElkPoint; bounds: Box }

// Match the small monospace badge, with room for padding, border, and a gap.
const labelHalfHeight = 11;
const labelGap = 4;

export function routePoints({ startPoint, bendPoints = [], endPoint }: ElkEdgeSection) {
  const distinct = [startPoint, ...bendPoints, endPoint].filter((point, index, points) => {
    const previous = points[index - 1];
    return !previous || point.x !== previous.x || point.y !== previous.y;
  });
  return distinct.filter((point, index) => {
    const previous = distinct[index - 1];
    const next = distinct[index + 1];
    if (!previous || !next) return true;
    const straightX = previous.y === point.y && point.y === next.y && (point.x - previous.x) * (next.x - point.x) > 0;
    const straightY = previous.x === point.x && point.x === next.x && (point.y - previous.y) * (next.y - point.y) > 0;
    return !straightX && !straightY;
  });
}

function boxAt({ x, y }: ElkPoint, halfWidth: number): Box {
  return {
    left: x - halfWidth, right: x + halfWidth,
    top: y - labelHalfHeight, bottom: y + labelHalfHeight,
  };
}

function overlaps(a: Box, b: Box) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function longestSegment(routes: ElkPoint[][]) {
  let anchor = routes[0][0];
  let length = 0;
  for (const points of routes) {
    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1];
      const end = points[index];
      const segment = Math.hypot(end.x - start.x, end.y - start.y);
      if (segment <= length) continue;
      anchor = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      length = segment;
    }
  }
  return { anchor, length };
}

function labelPlacement(anchor: ElkPoint, boxes: Box[], halfWidth: number): LabelPlacement | undefined {
  const bounds = boxAt(anchor, halfWidth);
  if (!boxes.some((box) => overlaps(bounds, box))) return { center: anchor, anchor, bounds };

  let best: LabelPlacement | undefined;
  let leastDistance = Infinity;
  for (const box of boxes) {
    const candidates = [
      { x: anchor.x, y: box.top - labelHalfHeight - labelGap },
      { x: anchor.x, y: box.bottom + labelHalfHeight + labelGap },
      { x: box.left - halfWidth - labelGap, y: anchor.y },
      { x: box.right + halfWidth + labelGap, y: anchor.y },
    ];
    for (const center of candidates) {
      const distance = Math.hypot(center.x - anchor.x, center.y - anchor.y);
      const bounds = boxAt(center, halfWidth);
      if (distance >= leastDistance || boxes.some((box) => overlaps(bounds, box))) continue;
      best = { center, anchor, bounds };
      leastDistance = distance;
    }
  }
  return best;
}

export function placeEdgeLabels(nodes: FlowNode[], edges: FlowEdge[]) {
  const positions = new Map(nodes.map(({ id, position }) => [id, position]));
  const byId = new Map<string, Box>();
  for (const { id, hidden, parentId, position, width = 0, height = 0 } of nodes) {
    if (hidden) continue;
    const parent = parentId ? positions.get(parentId) : undefined;
    const left = position.x + (parent?.x ?? 0);
    const top = position.y + (parent?.y ?? 0);
    const box = { left, top, right: left + width, bottom: top + height };
    byId.set(id, box);
  }

  const representatives = new Map<string, { id: string; label: string; anchor: ElkPoint; length: number }>();
  for (const { id, source, target, data } of edges) {
    const label = guardLabel(data.guard);
    if (!label || !byId.has(source) || !byId.has(target) || !data.sections.length) continue;
    const segment = longestSegment(data.sections.map(routePoints));
    const key = JSON.stringify([source, label]);
    const previous = representatives.get(key);
    if (!previous || segment.length > previous.length) representatives.set(key, { id, label, ...segment });
  }

  const obstacles = [...byId.values()];
  const placements = new Map<string, { label: string; placement: LabelPlacement }>();
  for (const { id, label, anchor } of representatives.values()) {
    // Reserve room for the live state suffix so refreshing a flag keeps the layout steady.
    const halfWidth = ((label.length + " · LIVE".length) * 7.5 + 18) / 2;
    const placement = labelPlacement(anchor, obstacles, halfWidth);
    if (placement) {
      placements.set(id, { label, placement });
      obstacles.push(placement.bounds);
    }
  }
  return {
    nodes,
    edges: edges.map((edge) => {
      const chosen = placements.get(edge.id);
      return { ...edge, label: chosen?.label, data: { ...edge.data, labelPlacement: chosen?.placement } };
    }),
    labelBounds: edgeLabelBounds([...placements.values()].map(({ placement }) => placement)),
  };
}

function edgeLabelBounds(placements: LabelPlacement[]): Rect | undefined {
  const boxes = placements.map(({ bounds }) => bounds);
  if (!boxes.length) return undefined;
  const x = Math.min(...boxes.map(({ left }) => left));
  const y = Math.min(...boxes.map(({ top }) => top));
  return {
    x, y,
    width: Math.max(...boxes.map(({ right }) => right)) - x,
    height: Math.max(...boxes.map(({ bottom }) => bottom)) - y,
  };
}
