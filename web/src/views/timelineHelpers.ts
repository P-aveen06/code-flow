import type { DiffStats, TimelineCommit } from "../types";

const commitDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

export function formatCommitDate(date: string) {
  return commitDate.format(new Date(date));
}

export function hasFlowChange(stats: DiffStats) {
  return Object.values(stats).some((count) => count !== 0);
}

export function filterTimeline(commits: TimelineCommit[], selectedSha: string | undefined, hideUnchanged: boolean) {
  const visible = hideUnchanged
    ? commits.filter(({ sha, stats }) => sha === selectedSha || hasFlowChange(stats))
    : commits;
  return { visible, hiddenCount: commits.length - visible.length };
}

export function nearestFlowChange(commits: TimelineCommit[], selectedSha: string) {
  const index = commits.findIndex(({ sha }) => sha === selectedSha);
  if (index === -1) return null;
  const changed = ({ stats }: TimelineCommit) => hasFlowChange(stats);
  const next = commits.slice(index + 1).find(changed);
  if (next) return { sha: next.sha, direction: "next" };
  const previous = commits.slice(0, index).reverse().find(changed);
  return previous ? { sha: previous.sha, direction: "previous" } : null;
}

export function formatFunctionCounts({ nodes_added, nodes_removed, nodes_changed }: DiffStats) {
  const noun = nodes_added === 1 ? "function" : "functions";
  return `${nodes_added} ${noun} added, ${nodes_removed} removed, ${nodes_changed} changed`;
}

export function formatStats(stats: DiffStats) {
  return {
    added: `+${stats.nodes_added}`,
    removed: `−${stats.nodes_removed}`,
    changed: `~${stats.nodes_changed}`,
  };
}

export function moveSelection(index: number, key: "ArrowUp" | "ArrowDown", count: number) {
  if (count === 0) return -1;
  const step = key === "ArrowUp" ? -1 : 1;
  return Math.max(0, Math.min(count - 1, index + step));
}

export function resolveCommit<T extends { sha: string }>(commits: T[], prefix: string | null) {
  if (prefix) {
    const exact = commits.find(({ sha }) => sha === prefix);
    if (exact) return exact;
    const matches = commits.filter(({ sha }) => sha.startsWith(prefix));
    if (matches.length === 1) return matches[0];
  }
  return commits.at(-1);
}
