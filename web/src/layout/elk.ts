import type { Edge, Node, Rect } from "@xyflow/react";
import type { ElkEdgeSection, ElkNode } from "elkjs/lib/elk.bundled.js";
import type { OverlayEdge, OverlayNode } from "../types";
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
): Promise<FlowLayout> {
  const modules = new Map<string, ElkNode & { children: ElkNode[] }>();
  const leaves = new Map<string, SymbolNode | ChipNode>();
  const standalone: ElkNode[] = [];

  // Pack modules with changed symbols before modules that only provide context.
  const ordered = [...nodes].sort((a, b) => Number(a.status === "context") - Number(b.status === "context"));
  for (const symbol of ordered) {
    const id = `module::${symbol.module}`;
    let group = modules.get(id);
    if (!group) {
      group = { id, children: [], layoutOptions: { ...ELK_OPTIONS.layeredSpacing, ...ELK_OPTIONS.module } };
      modules.set(id, group);
    }
    const elk = { id: symbol.id, ...symbolSize(symbol.qualname) };
    const node: SymbolNode = {
      ...elk, type: "symbol", data: { symbol }, position: { x: 0, y: 0 }, parentId: id, focusable: false,
    };
    leaves.set(elk.id, node);
    group.children.push(elk);
  }

  for (const chip of chips) {
    const group = modules.get(`module::${chip.module}`);
    const label = group ? `+${chip.count} unchanged` : contextLabel(chip);
    const elk = { id: chip.id, width: Math.max(104, Math.ceil(label.length * 7) + 18), height: 28 };
    const node: ChipNode = {
      ...elk, type: "context", data: { chip, label }, position: { x: 0, y: 0 },
      parentId: group?.id, focusable: false, draggable: false,
    };
    leaves.set(elk.id, node);
    (group?.children ?? standalone).push(elk);
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
    layoutOptions: { ...ELK_OPTIONS.layeredSpacing, ...ELK_OPTIONS.graph },
    children: [...modules.values(), ...standalone],
    edges: flowEdges.map(({ id, source, target }) => ({
      id,
      sources: [source],
      targets: [target],
    })),
  };
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  let result = await elk.layout(structuredClone(graph));
  const changed = new Set(nodes.filter(({ status }) => status !== "context").map(({ id }) => id));
  const focus = (result.children ?? []).flatMap((group) => (group.children ?? [])
    .filter((node) => changed.has(node.id))
    .map((node) => ({ left: (group.x ?? 0) + (node.x ?? 0), width: node.width ?? 0 })));
  const focusWidth = Math.max(...focus.map(({ left, width }) => left + width)) - Math.min(...focus.map(({ left }) => left));
  const guardedCalls = new Set(flowEdges.filter(({ data }) => data.guard).map(({ id }) => id));
  // Guard labels sit outside module boxes. Pack the full diagram when it is
  // too wide to show those labels without shrinking the comparison panes.
  const packed = focusWidth > (comparison ? 850 : 1600)
    || (guardedCalls.size > 0 && (result.width ?? 0) > (comparison ? 680 : 1450));
  if (packed) {
    result = await elk.layout({
      ...graph,
      layoutOptions: comparison ? { ...ELK_OPTIONS.packed, ...ELK_OPTIONS.packedComparison } : ELK_OPTIONS.packed,
      children: graph.children?.map((group) => group.children ? {
        ...group, layoutOptions: { ...group.layoutOptions, ...ELK_OPTIONS.stackedModule },
      } : group),
      edges: graph.edges?.filter(({ id, sources: [source], targets: [target] }) => {
        const parent = leaves.get(source)?.parentId;
        // Keep incidental context calls from spreading apart the comparison's changed symbols.
        const laysOut = !comparison || source === target || guardedCalls.has(id) || (changed.has(source) && changed.has(target));
        return laysOut && parent && parent === leaves.get(target)?.parentId;
      }),
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

  const extraRoutes = packedRoutes(flowNodes, flowEdges.filter(({ id }) => !sectionsById.get(id)?.length));
  for (const { id, data } of flowEdges) {
    data.sections = extraRoutes.get(id) ?? sectionsById.get(id) ?? [];
  }
  return placeEdgeLabels(flowNodes, flowEdges);
}
