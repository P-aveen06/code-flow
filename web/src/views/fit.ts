import { getViewportForBounds } from "@xyflow/react";
import type { Rect, Viewport } from "@xyflow/react";
import type { FlowLayout, FlowNode } from "../layout/elk";

const readableZoom = 0.65;
type ControlsPosition = "top-right" | "bottom-right";

export function includeLabelBounds(nodes: Rect, labels: Rect): Rect {
  const x = Math.min(nodes.x, labels.x);
  const y = Math.min(nodes.y, labels.y);
  const right = Math.max(nodes.x + nodes.width, labels.x + labels.width);
  const bottom = Math.max(nodes.y + nodes.height, labels.y + labels.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function nodeBounds(nodes: FlowNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const bounds = new Map<string, Rect>();
  for (const { id, hidden, parentId, position, width = 0, height = 0 } of nodes) {
    if (hidden) continue;
    const parent = parentId ? byId.get(parentId)?.position : undefined;
    bounds.set(id, { x: position.x + (parent?.x ?? 0), y: position.y + (parent?.y ?? 0), width, height });
  }
  return bounds;
}

function partlyVisible(rect: Rect, { x, y, zoom }: Viewport, width: number, height: number) {
  const left = rect.x * zoom + x;
  const top = rect.y * zoom + y;
  const right = left + rect.width * zoom;
  const bottom = top + rect.height * zoom;
  const epsilon = 1e-6;
  const intersects = right > epsilon && bottom > epsilon && left < width - epsilon && top < height - epsilon;
  return intersects && (left < -epsilon || top < -epsilon || right > width + epsilon || bottom > height + epsilon);
}

function avoidClippedContext(
  viewport: Viewport, focus: Rect, context: Rect[], width: number, height: number,
): Viewport | undefined {
  const clipsBox = (candidate: Viewport) => context.some((box) => partlyVisible(box, candidate, width, height));
  if (!clipsBox(viewport)) return viewport;

  const { zoom } = viewport;
  // A box stops straddling a viewport edge when one of their edges meets.
  // Only consider shifts that keep the whole changed neighbourhood in view.
  function offsets(origin: number, extent: number, size: number, preferred: number, spans: [number, number][]) {
    const min = -origin * zoom;
    const max = size - (origin + extent) * zoom;
    return [preferred, ...spans.flatMap(([start, length]) => {
      const first = -start * zoom;
      const last = -(start + length) * zoom;
      return [first, last, size + first, size + last];
    })].filter((offset) => offset >= min && offset <= max)
      .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
  }

  const xs = offsets(focus.x, focus.width, width, viewport.x, context.map(({ x, width }) => [x, width]));
  const ys = offsets(focus.y, focus.height, height, viewport.y, context.map(({ y, height }) => [y, height]));
  let best: Viewport | undefined;
  let distance = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const shift = Math.abs(x - viewport.x) + Math.abs(y - viewport.y);
      if (shift >= distance) break;
      const candidate = { x, y, zoom };
      if (clipsBox(candidate)) continue;
      best = candidate;
      distance = shift;
      break;
    }
  }
  return best;
}

export function diagramFit(
  layout: FlowLayout, width: number, height: number, controls: ControlsPosition, allowFocus = true,
): Viewport | undefined {
  const boxes = nodeBounds(layout.nodes);
  const bounds = [...boxes.values()];
  if (!bounds.length || width <= 0 || height <= 0) return undefined;

  // Keep room for the controls at either edge, even in a narrow comparison pane.
  const controlsInset = `${Math.min(48, height / 4)}px` as const;
  const padding = controls === "top-right"
    ? { x: 0.14, y: 0.14, top: controlsInset }
    : { x: 0.14, y: 0.14, bottom: controlsInset };
  const allNodes = bounds.reduce(includeLabelBounds);
  let allBounds = layout.labelBounds ? includeLabelBounds(allNodes, layout.labelBounds) : allNodes;
  for (const { source, target, hidden, data } of layout.edges) {
    if (hidden || !boxes.has(source) || !boxes.has(target)) continue;
    for (const { startPoint, bendPoints = [], endPoint } of data.sections) {
      for (const point of [startPoint, ...bendPoints, endPoint]) {
        allBounds = includeLabelBounds(allBounds, { ...point, width: 0, height: 0 });
      }
    }
  }
  const all = getViewportForBounds(allBounds, width, height, 0, 1.25, padding);
  if (!allowFocus || all.zoom >= readableZoom) return all;
  const readableAll = getViewportForBounds(allBounds, width, height, 0, readableZoom, 0);
  if (readableAll.zoom >= readableZoom) return readableAll;

  const changed = new Set(layout.nodes.flatMap((node) => (
    node.type === "symbol" && node.data.symbol.status !== "context" && boxes.has(node.id) ? [node.id] : []
  )));
  if (!changed.size) return all;

  const focusIds = new Set(changed);
  for (const { source, target, hidden } of layout.edges) {
    if (hidden) continue;
    if (changed.has(source)) focusIds.add(target);
    if (changed.has(target)) focusIds.add(source);
  }
  const focus = [...boxes].flatMap(([id, box]) => focusIds.has(id) ? [box] : []).reduce(includeLabelBounds);
  const viewport = getViewportForBounds(focus, width, height, 0, 1, padding);
  const unpaddedFocus = getViewportForBounds(focus, width, height, 0, readableZoom, 0);

  // Module backgrounds can extend beyond the viewport. Try to keep any other
  // symbols or context chips that appear at the edges whole as well.
  const context = layout.nodes.flatMap(({ id, type }) => {
    const box = boxes.get(id);
    return box && type !== "module" && !focusIds.has(id) ? [box] : [];
  });
  const preferred = viewport.zoom >= readableZoom ? viewport : unpaddedFocus;
  const uncropped = avoidClippedContext(preferred, focus, context, width, height);
  if (uncropped || preferred === unpaddedFocus) return uncropped ?? preferred;
  return avoidClippedContext(unpaddedFocus, focus, context, width, height) ?? preferred;
}
