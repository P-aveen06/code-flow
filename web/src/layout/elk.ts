import type { Edge, Node, Rect } from "@xyflow/react";
import type { ElkEdgeSection, ElkNode } from "elkjs/lib/elk.bundled.js";
import type { OverlayEdge, OverlayNode } from "../types";
import type { FlowDirection } from "../view";
import { callKey, contextLabel } from "../views/collapse";
import type { ContextChip } from "../views/collapse";
import { symbolSize } from "../views/styles";
import { placeEdgeLabels } from "./edgeLabels";
import { packedRoutes } from "./packedRoutes";
import type { LabelPlacement } from "./edgeLabels";

export const ELK_OPTIONS = {
  layeredSpacing: {
    "elk.spacing.nodeNode": "36",
    "elk.spacing.componentComponent": "64",
    "elk.spacing.edgeNode": "28",
    "elk.spacing.edgeEdge": "18",
    "elk.spacing.portPort": "12",
    "elk.layered.spacing.nodeNodeBetweenLayers": "72",
    "elk.layered.spacing.edgeNodeBetweenLayers": "32",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "18",
  },
  graph: {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "org.eclipse.elk.json.edgeCoords": "ROOT",
    "elk.aspectRatio": "2.0",
    "elk.spacing.nodeNode": "64",
    "elk.layered.spacing.nodeNodeBetweenLayers": "88",
    "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
    // ELK wrapping can fail on hierarchy-crossing calls. Wide layouts use the packed options below.
    "elk.layered.wrapping.strategy": "OFF",
  },
  module: { "elk.padding": "[top=48,left=24,bottom=24,right=24]" },
  packed: {
    "elk.algorithm": "box",
    "elk.hierarchyHandling": "SEPARATE_CHILDREN",
    "elk.aspectRatio": "1.9",
    "elk.spacing.nodeNode": "52",
    "org.eclipse.elk.json.edgeCoords": "ROOT",
  },
  packedComparison: { "elk.aspectRatio": "1.0", "elk.box.packingMode": "GROUP_DEC" },
  stackedModule: {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
    "elk.spacing.nodeNode": "24",
    "elk.layered.spacing.nodeNodeBetweenLayers": "32",
    "elk.layered.layering.strategy": "COFFMAN_GRAHAM",
    "elk.layered.layering.coffmanGraham.layerBound": "1",
  },
};

export type SymbolNode = Node<{ symbol: OverlayNode }, "symbol">;
export type ChipNode = Node<{ chip: ContextChip; label: string }, "context">;
export type ModuleNode = Node<{ label: string }, "module">;
export type FlowNode = SymbolNode | ChipNode | ModuleNode;
type CallData = Omit<OverlayEdge, "source" | "target"> & {
  sections: ElkEdgeSection[];
  labelPlacement?: LabelPlacement;
};
export type FlowEdge = Edge<CallData> & { data: CallData; label?: string };

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
  labelBounds?: Rect;
}

function position(node: ElkNode) {
  return { x: node.x ?? 0, y: node.y ?? 0 };
}

export async function layoutFlow(
  nodes: OverlayNode[], edges: OverlayEdge[], chips: ContextChip[] = [], comparison = false,
  direction: FlowDirection = "horizontal",
): Promise<FlowLayout> {
  const vertical = direction === "vertical";
  const modules = new Map<string, ElkNode & { children: ElkNode[] }>();
  const leaves = new Map<string, SymbolNode | ChipNode>();
  const standalone: ElkNode[] = [];

  function leaf(id: string, size: { width: number; height: number }): ElkNode {
    return vertical ? {
      id, ...size, layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: [
        { id: `${id}:in`, width: 0, height: 0, layoutOptions: { "elk.port.side": "NORTH" } },
        { id: `${id}:out`, width: 0, height: 0, layoutOptions: { "elk.port.side": "SOUTH" } },
      ],
    } : { id, ...size };
  }

  // Pack modules with changed symbols before modules that only provide context.
  const ordered = [...nodes].sort((a, b) => Number(a.status === "context") - Number(b.status === "context"));
  for (const symbol of ordered) {
    const id = `module::${symbol.module}`;
    let group = modules.get(id);
    if (!group) {
      group = { id, children: [], layoutOptions: { ...ELK_OPTIONS.layeredSpacing, ...ELK_OPTIONS.module } };
      modules.set(id, group);
    }
    const size = symbolSize(symbol);
    const node: SymbolNode = {
      id: symbol.id, ...size, type: "symbol", data: { symbol }, position: { x: 0, y: 0 }, parentId: id, focusable: false,
    };
    leaves.set(node.id, node);
    group.children.push(leaf(node.id, size));
  }

  for (const chip of chips) {
    const group = modules.get(`module::${chip.module}`);
    const label = group ? `+${chip.count} unchanged` : contextLabel(chip);
    const size = { width: Math.max(104, Math.ceil(label.length * 7) + 18), height: 28 };
    const node: ChipNode = {
      id: chip.id, ...size, type: "context", data: { chip, label }, position: { x: 0, y: 0 },
      parentId: group?.id, focusable: false, draggable: false,
    };
    leaves.set(node.id, node);
    (group?.children ?? standalone).push(leaf(node.id, size));
  }

  const flowEdges: FlowEdge[] = edges.map((edge) => {
    const { source, target, ...data } = edge;
    return {
      id: `edge:${callKey(edge)}`,
      source,
      target,
      data: { ...data, sections: [] },
    };
  });

  if (!leaves.size) return { nodes: [], edges: flowEdges };

  const graph: ElkNode = {
    id: "graph",
    layoutOptions: { ...ELK_OPTIONS.layeredSpacing, ...ELK_OPTIONS.graph, "elk.direction": vertical ? "DOWN" : "RIGHT" },
    children: [...modules.values(), ...standalone],
    edges: flowEdges.map(({ id, source, target }) => ({
      id,
      sources: [vertical ? `${source}:out` : source],
      targets: [vertical ? `${target}:in` : target],
    })),
  };
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  let result = await elk.layout(structuredClone(graph));
  const changed = new Set(nodes.filter(({ status }) => status !== "context").map(({ id }) => id));
  const axis = vertical ? "y" : "x";
  const extent = vertical ? "height" : "width";
  const focus = (result.children ?? []).flatMap((group) => (group.children ?? [])
    .filter((node) => changed.has(node.id))
    .map((node) => ({ start: (group[axis] ?? 0) + (node[axis] ?? 0), size: node[extent] ?? 0 })));
  const focusSpan = Math.max(...focus.map(({ start, size }) => start + size)) - Math.min(...focus.map(({ start }) => start));
  const guardedCalls = new Set(flowEdges.filter(({ data }) => data.guard).map(({ id }) => id));
  // Guard labels sit outside module boxes, so pack sooner when they need space.
  const packed = focusSpan > (comparison ? 850 : 1600)
    || (guardedCalls.size > 0 && (result[extent] ?? 0) > (comparison ? 680 : 1450));
  if (packed) {
    // Vertical packing uses the wider rows to break up tall columns of modules.
    const packedOptions = comparison ? {
      ...ELK_OPTIONS.packed,
      ...ELK_OPTIONS.packedComparison,
      "elk.aspectRatio": vertical ? ELK_OPTIONS.packed["elk.aspectRatio"] : ELK_OPTIONS.packedComparison["elk.aspectRatio"],
    } : ELK_OPTIONS.packed;
    const packedEdges = new Set(flowEdges.filter(({ id, source, target }) => {
      const parent = leaves.get(source)?.parentId;
      // Keep incidental context calls from spreading apart the comparison's changed symbols.
      const laysOut = !comparison || source === target || guardedCalls.has(id) || (changed.has(source) && changed.has(target));
      return laysOut && parent && parent === leaves.get(target)?.parentId;
    }).map(({ id }) => id));
    result = await elk.layout({
      ...graph,
      layoutOptions: packedOptions,
      children: graph.children?.map((group) => group.children ? {
        ...group, layoutOptions: { ...group.layoutOptions, ...ELK_OPTIONS.stackedModule },
      } : group),
      edges: graph.edges?.filter(({ id }) => packedEdges.has(id)),
    });
  }
  const { children: groups = [], edges: routedEdges = [] } = result;
  const sectionsById = new Map(routedEdges.map(({ id, sections }) => [id, sections]));
  const flowNodes: FlowNode[] = [];

  for (const group of groups) {
    const leaf = leaves.get(group.id);
    if (leaf) {
      flowNodes.push({ ...leaf, position: position(group) });
      continue;
    }
    flowNodes.push({
      id: group.id,
      type: "module",
      data: { label: group.id.slice("module::".length) || "External" },
      position: position(group),
      width: group.width,
      height: group.height,
      selectable: false,
      focusable: false,
    });

    for (const child of group.children ?? []) {
      flowNodes.push({ ...leaves.get(child.id)!, position: position(child) });
    }
  }

  const extraRoutes = packedRoutes(flowNodes, flowEdges.filter(({ id }) => !sectionsById.get(id)?.length), direction);
  for (const { id, data } of flowEdges) {
    data.sections = extraRoutes.get(id) ?? sectionsById.get(id) ?? [];
  }
  return placeEdgeLabels(flowNodes, flowEdges);
}
