import type { OverlayEdge, OverlayNode } from "../types";

export interface ContextChip {
  id: string;
  module: string;
  count: number;
  in_base: boolean;
  in_head: boolean;
}

export type ExpandedContext = ReadonlySet<string> | "all";

export function contextLabel({ count, module }: ContextChip) {
  return `+${count} unchanged in ${module || "External"}`;
}

export function callKey({ source, target, status, guard }: OverlayEdge) {
  return JSON.stringify([source, target, status, guard?.flag, guard?.when]);
}

export function collapseContext(
  nodes: OverlayNode[], edges: OverlayEdge[], expanded: ExpandedContext,
) {
  if (expanded === "all") return { nodes, edges, chips: [] };

  const changed = new Set(nodes.filter(({ status }) => status !== "context").map(({ id }) => id));
  const keep = new Set(changed);
  for (const { source, target, guard, status } of edges) {
    if (guard || (status !== "context" && changed.has(target))) keep.add(source);
    if (guard || (status !== "context" && changed.has(source))) keep.add(target);
  }

  const chips = new Map<string, ContextChip>();
  const redirects = new Map<string, string>();
  const visible = nodes.filter((node) => {
    if (keep.has(node.id) || expanded.has(node.module)) return true;

    let chip = chips.get(node.module);
    if (!chip) {
      chip = {
        id: `context::${node.module}`, module: node.module, count: 0, in_base: false, in_head: false,
      };
      chips.set(node.module, chip);
    }
    chip.count++;
    chip.in_base ||= node.in_base;
    chip.in_head ||= node.in_head;
    redirects.set(node.id, chip.id);
    return false;
  });

  const calls = new Map<string, OverlayEdge>();
  for (const edge of edges) {
    const source = redirects.get(edge.source) ?? edge.source;
    const target = redirects.get(edge.target) ?? edge.target;
    // Calls internal to a chip are visible when its module is expanded.
    if (source === target && redirects.has(edge.source)) continue;

    const redirected = { ...edge, source, target };
    const key = callKey(redirected);
    const prior = calls.get(key);
    calls.set(key, prior ? {
      ...prior,
      in_base: prior.in_base || edge.in_base,
      in_head: prior.in_head || edge.in_head,
    } : redirected);
  }

  return { nodes: visible, edges: [...calls.values()], chips: [...chips.values()] };
}
