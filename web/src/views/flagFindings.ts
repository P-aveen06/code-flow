import type { FlagFinding, FlagStatus, Guard, RepoFlags } from "../types";

export const flagStatusText: Record<FlagStatus, string> = {
  orphan: "Orphan",
  live: "Live",
  off: "Off",
  unused: "Unused",
  unknown: "Unknown",
};

export function groupFlagFindings(flags: FlagFinding[]) {
  return (Object.keys(flagStatusText) as FlagStatus[]).flatMap((status) => {
    const findings = flags.filter((flag) => flag.status === status)
      .sort((a, b) => a.name.localeCompare(b.name));
    return findings.length ? [{ status, findings }] : [];
  });
}

export function flagConnectionText(connection: RepoFlags["flagsmith"], now: number) {
  if (!connection.connected) return connection.error ?? "Could not connect to Flagsmith.";

  const updatedAt = connection.fetched_at ? Date.parse(connection.fetched_at) : NaN;
  const elapsed = Math.max(0, Math.floor((now - updatedAt) / 1000));
  return [
    "Live from Flagsmith", connection.environment,
    Number.isFinite(elapsed) ? `updated ${elapsed} s ago` : null,
  ].filter(Boolean).join(" · ");
}

export function liveFlagStates(data: RepoFlags | undefined) {
  const states = new Map<string, boolean>();
  if (data?.flagsmith.connected) {
    for (const { name, enabled, in_flagsmith } of data.flags) {
      if (in_flagsmith && enabled !== null) states.set(name, enabled);
    }
  }
  return states;
}

export type GuardActivity = "live" | "off";

export function guardActivity(guard: Guard | null, states: ReadonlyMap<string, boolean>): GuardActivity | undefined {
  const enabled = guard ? states.get(guard.flag) : undefined;
  if (!guard || enabled === undefined) return undefined;
  return enabled === (guard.when === "on") ? "live" : "off";
}

export function toggleFlagSelection(selected: string | undefined, name: string) {
  return selected === name ? undefined : name;
}

export function highlightedPaths(
  nodes: readonly { id: string; parentId?: string; hidden?: boolean }[],
  edges: readonly { id: string; source: string; target: string; data: { guard: Guard | null } }[],
  finding: Pick<FlagFinding, "name" | "checks"> | undefined,
) {
  if (!finding) return null;

  const nodeIds = new Set(finding.checks.map((check) => check.function));
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edge.data.guard?.flag !== finding.name) continue;
    edgeIds.add(edge.id);
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
  const visible = nodes.filter((node) => !node.hidden && nodeIds.has(node.id));
  if (!visible.length && !edgeIds.size) return null;
  for (const { parentId } of visible) {
    if (parentId) nodeIds.add(parentId);
  }
  return { nodeIds, edgeIds };
}
