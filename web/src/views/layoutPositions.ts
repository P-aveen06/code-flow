import type { NodeChange, XYPosition } from "@xyflow/react";
import { useState } from "react";
import { placeEdgeLabels } from "../layout/edgeLabels";
import type { FlowLayout, FlowNode } from "../layout/elk";
import { packedRoutes } from "../layout/packedRoutes";
import type { FlowDirection, FlowView } from "../view";

type Positions = ReadonlyMap<string, XYPosition>;
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function layoutPositionKey(repo: string, commit: string, view: FlowView, direction: FlowDirection) {
  return `code-flow:layout:${JSON.stringify([repo, commit, view, direction])}`;
}

function legacyHorizontalKey(key: string) {
  const suffix = ',"horizontal"]';
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) + "]" : null;
}

export function readLayoutPositions(key: string, storage?: SessionStorage): Positions {
  const positions = new Map<string, XYPosition>();
  try {
    const session = storage ?? window.sessionStorage;
    const legacy = legacyHorizontalKey(key);
    const raw: unknown = JSON.parse(session.getItem(key) ?? (legacy && session.getItem(legacy)) ?? "null");
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (!Array.isArray(entry)) continue;
        const [id, point] = entry;
        if (typeof id === "string" && Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
          positions.set(id, { x: point.x, y: point.y });
        }
      }
    }
  } catch {
    // Layout editing still works when session storage is unavailable.
  }
  return positions;
}

export function writeLayoutPositions(key: string, positions: Positions, storage?: SessionStorage) {
  try {
    const session = storage ?? window.sessionStorage;
    if (positions.size) session.setItem(key, JSON.stringify([...positions]));
    else session.removeItem(key);
    const legacy = legacyHorizontalKey(key);
    if (legacy) session.removeItem(legacy);
  } catch {
    // Keep using the in-memory positions.
  }
}

export function applyLayoutPositions(
  layout: FlowLayout, positions: Positions, direction: FlowDirection = "horizontal",
): FlowLayout {
  if (!positions.size) return layout;

  const moved = new Set<string>();
  const nodes = layout.nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position || (position.x === node.position.x && position.y === node.position.y)) return node;
    moved.add(node.id);
    return { ...node, position };
  });
  if (!moved.size) return layout;

  // Child coordinates are relative to the module. Its move also invalidates their edge routes.
  const movedEndpoints = new Set(nodes.filter(({ id, parentId }) => (
    moved.has(id) || (parentId && moved.has(parentId))
  )).map(({ id }) => id));
  const affected = layout.edges.filter(({ source, target }) => movedEndpoints.has(source) || movedEndpoints.has(target));
  const routes = packedRoutes(nodes, affected, direction);
  const edges = layout.edges.map((edge) => {
    const sections = routes.get(edge.id);
    return sections ? { ...edge, data: { ...edge.data, sections } } : edge;
  });
  return placeEdgeLabels(nodes, edges);
}

function stateForKey(key: string) {
  return { key, positions: readLayoutPositions(key), resetCount: 0 };
}

export function useLayoutPositions(key: string) {
  const [state, setState] = useState(() => stateForKey(key));
  if (state.key !== key) setState(stateForKey(key));

  function onNodesChange(changes: NodeChange<FlowNode>[]) {
    const updates = changes.flatMap((change) => change.type === "position" && change.dragging && change.position
      ? [[change.id, change.position] as const] : []);
    if (updates.length) {
      setState((current) => current.key === key
        ? { ...current, positions: new Map([...current.positions, ...updates]) }
        : current);
    }
  }

  function finishDrag(nodes: FlowNode[]) {
    const positions = new Map(state.positions);
    for (const { id, position } of nodes) positions.set(id, position);
    setState((current) => current.key === key ? { ...current, positions } : current);
    writeLayoutPositions(key, positions);
  }

  function reset() {
    const positions = new Map<string, XYPosition>();
    setState({ key, positions, resetCount: state.resetCount + 1 });
    writeLayoutPositions(key, positions);
  }

  return { positions: state.positions, resetCount: state.resetCount, onNodesChange, finishDrag, reset };
}

export type LayoutPositionControls = ReturnType<typeof useLayoutPositions>;
