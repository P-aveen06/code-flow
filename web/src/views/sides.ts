import type { FlowLayout } from "../layout/elk";

export type Revision = "base" | "head";

export function sideOf(layout: FlowLayout, side: Revision): FlowLayout {
  const presence = side === "base" ? "in_base" : "in_head";
  const visibleIds = new Set<string>();

  for (const node of layout.nodes) {
    if (node.type === "module") continue;
    const item = node.type === "symbol" ? node.data.symbol : node.data.chip;
    if (item[presence]) {
      visibleIds.add(node.id);
      if (node.parentId) visibleIds.add(node.parentId);
    }
  }

  return {
    nodes: layout.nodes.filter(({ id }) => visibleIds.has(id)),
    edges: layout.edges.filter(
      ({ source, target, data }) => data[presence] && visibleIds.has(source) && visibleIds.has(target),
    ),
  };
}
