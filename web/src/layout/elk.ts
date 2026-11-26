import type { Edge, Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import type { OverlayEdge, OverlayNode } from "../types";

const ELK_OPTIONS = {
  graph: {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.spacing.nodeNode": "32",
    "elk.layered.spacing.nodeNodeBetweenLayers": "96",
  },
  module: { "elk.padding": "[top=40,left=20,bottom=20,right=20]" },
};

export type SymbolNode = Node<{ symbol: OverlayNode }, "symbol">;
export type ModuleNode = Node<{ label: string }, "module">;
export type FlowNode = SymbolNode | ModuleNode;
type CallData = Pick<OverlayEdge, "status" | "guard">;
export type FlowEdge = Edge<CallData> & { data: CallData };

function position(node: ElkNode) {
  return { x: node.x ?? 0, y: node.y ?? 0 };
}

export async function layoutFlow(nodes: OverlayNode[], edges: OverlayEdge[]) {
  const modules = new Map<string, ElkNode & { children: ElkNode[] }>();
  const symbols = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    const id = `module::${node.module}`;
    let group = modules.get(id);
    if (!group) {
      group = { id, children: [], layoutOptions: ELK_OPTIONS.module };
      modules.set(id, group);
    }
    group.children.push({
      id: node.id,
      width: Math.max(140, node.qualname.length * 8 + 24),
      height: 44,
    });
  }

  const flowEdges: FlowEdge[] = edges.map(({ source, target, status, guard }) => ({
    id: `edge:${JSON.stringify([source, target])}`,
    source,
    target,
    data: { status, guard },
  }));

  if (!nodes.length) return { nodes: [], edges: flowEdges };

  const graph: ElkNode = {
    id: "graph",
    layoutOptions: ELK_OPTIONS.graph,
    children: [...modules.values()],
    edges: flowEdges.map(({ id, source, target }) => ({ id, sources: [source], targets: [target] })),
  };
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const { children: groups = [] } = await elk.layout(graph);
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

  return { nodes: flowNodes, edges: flowEdges };
}
