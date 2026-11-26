import type { DiffStats } from "../types";

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
