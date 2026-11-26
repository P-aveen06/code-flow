import type { Edge, Node } from "@xyflow/react";
import type { ElkEdgeSection, ElkNode } from "elkjs/lib/elk.bundled.js";
import type { OverlayEdge, OverlayNode } from "../types";
import { guardLabel, symbolHint } from "../views/styles";

const ELK_OPTIONS = {
  graph: {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "org.eclipse.elk.json.edgeCoords": "ROOT",
    "elk.spacing.nodeNode": "32",
    "elk.layered.spacing.nodeNodeBetweenLayers": "96",
  },
  module: { "elk.padding": "[top=40,left=20,bottom=20,right=20]" },
};

export type SymbolNode = Node<{ symbol: OverlayNode }, "symbol">;
export type ModuleNode = Node<{ label: string }, "module">;
export type FlowNode = SymbolNode | ModuleNode;
type CallData = Omit<OverlayEdge, "source" | "target"> & {
  sections: ElkEdgeSection[];
  labelWidth: number;
};
export type FlowEdge = Edge<CallData> & { data: CallData; label?: string };

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

function position(node: ElkNode) {
  return { x: node.x ?? 0, y: node.y ?? 0 };
}

export async function layoutFlow(nodes: OverlayNode[], edges: OverlayEdge[]): Promise<FlowLayout> {
  const modules = new Map<string, ElkNode & { children: ElkNode[] }>();
  const symbols = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    const id = `module::${node.module}`;
    let group = modules.get(id);
    if (!group) {
      group = { id, children: [], layoutOptions: ELK_OPTIONS.module };
      modules.set(id, group);
    }
    // Approximate the 14px monospace name and sans-serif hint, with 26px for padding and border.
    const nameWidth = node.qualname.length * 9;
    const hintWidth = symbolHint(node).length * 7.5;
    group.children.push({
      id: node.id,
      width: Math.max(140, Math.ceil(Math.max(nameWidth, hintWidth)) + 26),
      height: 48,
    });
  }

  const flowEdges: FlowEdge[] = edges.map(({ source, target, ...data }) => {
    const label = guardLabel(data.guard);
    return {
      id: `edge:${JSON.stringify([source, target])}`,
      source,
      target,
      label,
      // Allow for the monospace text, background padding and border.
      data: { ...data, sections: [], labelWidth: label ? label.length * 9 + 18 : 0 },
    };
  });

  if (!nodes.length) return { nodes: [], edges: flowEdges };

  const graph: ElkNode = {
    id: "graph",
    layoutOptions: ELK_OPTIONS.graph,
    children: [...modules.values()],
    edges: flowEdges.map(({ id, source, target, label, data }) => ({
      id,
      sources: [source],
      targets: [target],
      labels: label ? [{
        text: label,
        width: data.labelWidth,
        height: 28,
        layoutOptions: { "elk.edgeLabels.inline": "true" },
      }] : undefined,
    })),
  };
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const { children: groups = [], edges: routedEdges = [] } = await elk.layout(graph);
  const sectionsById = new Map(routedEdges.map(({ id, sections }) => [id, sections]));
  const flowNodes: FlowNode[] = [];

  for (const group of groups) {
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
      flowNodes.push({
        id: child.id,
        type: "symbol",
        data: { symbol: symbols.get(child.id)! },
        parentId: group.id,
        position: position(child),
        width: child.width,
        height: child.height,
        focusable: false,
      });
    }
  }

  return {
    nodes: flowNodes,
    edges: flowEdges.map((edge) => ({
      ...edge,
      data: { ...edge.data, sections: sectionsById.get(edge.id) ?? [] },
    })),
  };
}
