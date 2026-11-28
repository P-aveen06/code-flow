import type { CSSProperties } from "react";
import type { EdgeStatus, Guard, NodeStatus, OverlayNode } from "../types";
import type { GuardActivity } from "./flagFindings";

export const statusLabels: Record<NodeStatus, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  context: "Context",
};

export function shortFilePath(file: string): string {
  const segments = file.split("/");
  return segments.length > 2 ? `…/${segments.slice(-2).join("/")}` : file;
}

export function formatLineCounts(added?: number | null, removed?: number | null) {
  if (added == null || removed == null) return { added: "", removed: "" };
  return {
    added: added ? `+${added}` : "",
    removed: removed ? `−${removed}` : "",
  };
}

export function symbolName(symbol: OverlayNode): string {
  return symbol.kind === "module" ? symbol.module || symbol.name : symbol.qualname;
}

export function symbolKindLabel(kind: OverlayNode["kind"]): string {
  return kind === "function" ? "fn" : kind;
}

export function symbolLabel(symbol: OverlayNode): string {
  const { kind, status, lines_added, lines_removed, file, line } = symbol;
  const parts = [symbolName(symbol), kind, status];
  if (status !== "context" && lines_added != null && lines_removed != null) {
    parts.push(`${lines_added} lines added`, `${lines_removed} removed`);
  }
  if (file) parts.push(`${file} line ${line}`);
  return parts.join(", ");
}

export function symbolNameLines(name: string): string[] {
  const lineLength = 28;
  const lines: string[] = [];
  if (name.length > lineLength) {
    const breaks = [...name.slice(0, lineLength + 1).matchAll(/[_.]|[a-z][A-Z]/g)];
    const separator = breaks.at(-1)?.index ?? 0;
    const end = separator >= lineLength / 2 ? Math.min(separator + 1, lineLength) : lineLength;
    lines.push(name.slice(0, end));
    name = name.slice(end);
  }
  lines.push(name.length > lineLength ? `${name.slice(0, lineLength - 1)}…` : name);
  return lines;
}

export function symbolSize(symbol: OverlayNode) {
  const lines = symbolNameLines(symbolName(symbol));
  // The card uses 14px mono for the name and 11.7px mono for metadata.
  const nameWidth = Math.max(...lines.map((line) =>
    [...line].reduce((width, char) => width + (char.charCodeAt(0) > 0x2ff ? 15 : 8.6), 0),
  ));
  const kindWidth = symbolKindLabel(symbol.kind).length * 7.2;
  const counts = symbol.status === "context" ? formatLineCounts() : formatLineCounts(symbol.lines_added, symbol.lines_removed);
  const countsWidth = [counts.added, counts.removed].filter(Boolean).join(" ").length * 7.2;
  const locationWidth = Math.min(shortFilePath(symbol.file).length, 36) * 7.2 + `:${symbol.line}`.length * 7.2;
  return {
    width: Math.max(152, Math.ceil(kindWidth + nameWidth + countsWidth + 16) + 18, Math.ceil(locationWidth) + 18),
    height: 56 + (lines.length - 1) * 17,
  };
}

const statusColors: Record<NodeStatus, string> = {
  added: "var(--diagram-added)",
  removed: "var(--diagram-removed)",
  changed: "var(--diagram-changed)",
  context: "var(--diagram-context)",
};

const statusFills: Record<NodeStatus, string> = {
  added: "var(--diagram-added-fill)",
  removed: "var(--diagram-removed-fill)",
  changed: "var(--diagram-changed-fill)",
  context: "var(--diagram-context-fill)",
};

export function nodeStyle(status: NodeStatus): CSSProperties {
  return {
    backgroundColor: statusFills[status],
    borderColor: statusColors[status],
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
