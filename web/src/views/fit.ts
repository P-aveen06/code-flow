import type { Rect } from "@xyflow/react";

export function chooseFitTarget(allBoundsZoom: number, minReadableZoom: number): "all" | "changed" {
  return allBoundsZoom >= minReadableZoom ? "all" : "changed";
}

export function includeLabelBounds(nodes: Rect, labels: Rect): Rect {
  const x = Math.min(nodes.x, labels.x);
  const y = Math.min(nodes.y, labels.y);
  const right = Math.max(nodes.x + nodes.width, labels.x + labels.width);
  const bottom = Math.max(nodes.y + nodes.height, labels.y + labels.height);
  return { x, y, width: right - x, height: bottom - y };
}
