import type { CSSProperties } from "react";
import type { EdgeStatus, Guard, NodeStatus, OverlayNode } from "../types";
import type { GuardActivity } from "./flagFindings";

export const statusLabels: Record<NodeStatus, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  context: "Context",
};

export function symbolHint({ kind, status }: OverlayNode): string {
  return `${kind} · ${statusLabels[status]}`;
}

export function symbolNameLines(name: string): string[] {
  const lineLength = 28;
  const lines: string[] = [];
  while (name.length > lineLength) {
    const breaks = [...name.slice(0, lineLength + 1).matchAll(/[_.]|[a-z][A-Z]/g)];
    const separator = breaks.at(-1)?.index ?? 0;
    const end = separator >= lineLength / 2 ? Math.min(separator + 1, lineLength) : lineLength;
    lines.push(name.slice(0, end));
    name = name.slice(end);
  }
  lines.push(name);
  return lines;
}

const statusColors: Record<NodeStatus, string> = {
  added: "var(--color-success)",
  removed: "var(--color-danger)",
  changed: "var(--color-warning)",
  context: "var(--color-text-subtle)",
};

export function nodeStyle(status: NodeStatus): CSSProperties {
  const color = statusColors[status];
  return {
    backgroundColor: `color-mix(in srgb, ${color} 9%, var(--color-surface))`,
    borderColor: color,
    borderStyle: status === "removed" ? "dashed" : "solid",
  };
}

export function edgeStyle(status: EdgeStatus, activity?: GuardActivity): CSSProperties {
  if (activity === "live") return { stroke: statusColors.added, strokeWidth: 3.5 };
  if (activity === "off") return { stroke: statusColors.context, strokeWidth: 2, strokeDasharray: "6 4" };
  return {
    stroke: statusColors[status],
    strokeWidth: status === "context" ? 1.5 : 2,
    strokeDasharray: status === "removed" ? "6 4" : undefined,
  };
}

export function guardLabel(guard: Guard | null, activity?: GuardActivity): string | undefined {
  if (!guard) return undefined;
  const label = `${guard.flag}: ${guard.when}`;
  return activity ? `${label} · ${activity.toUpperCase()}` : label;
}
