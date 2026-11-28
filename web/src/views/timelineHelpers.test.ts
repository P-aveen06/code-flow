import { describe, expect, it } from "vitest";
import type { DiffStats, TimelineCommit } from "../types";
import {
  filterTimeline, formatFunctionCounts, formatStats, hasFlowChange, moveSelection,
  nearestFlowChange, resolveCommit,
} from "./timelineHelpers";

const noChange: DiffStats = { nodes_added: 0, nodes_removed: 0, nodes_changed: 0, edges_added: 0, edges_removed: 0 };

function commit(sha: string, stats: DiffStats = noChange): TimelineCommit {
  return { sha, stats, parents: [], author: "", date: "", message: "", summary: "" };
}

const commits: TimelineCommit[] = [
  commit("first", { ...noChange, nodes_added: 2 }),
  commit("docs"),
  commit("call", { ...noChange, edges_removed: 1 }),
  commit("readme"),
];

describe("timeline", () => {
  it("formats the node counts for badges", () => {
    expect(formatStats({
      nodes_added: 5,
      nodes_removed: 2,
      nodes_changed: 0,
      edges_added: 8,
      edges_removed: 3,
    })).toEqual({ added: "+5", removed: "−2", changed: "~0" });
  });

  it("uses singular, plural and zero for function counts", () => {
    expect(formatFunctionCounts({ ...noChange, nodes_added: 1, nodes_changed: 1 })).toBe("1 function added, 0 removed, 1 changed");
    expect(formatFunctionCounts({ ...noChange, nodes_added: 2, nodes_removed: 3 })).toBe("2 functions added, 3 removed, 0 changed");
    expect(formatFunctionCounts(noChange)).toBe("0 functions added, 0 removed, 0 changed");
  });

  it("considers all five stats when identifying commits with no flow change", () => {
    expect(hasFlowChange(noChange)).toBe(false);
    for (const stat of Object.keys(noChange)) {
      expect(hasFlowChange({ ...noChange, [stat]: 1 })).toBe(true);
    }
  });

  it("hides unchanged rows, keeps the selected one, and reports the number hidden", () => {
    expect(filterTimeline(commits, "call", true)).toEqual({ visible: [commits[0], commits[2]], hiddenCount: 2 });
    expect(filterTimeline(commits, "docs", true)).toEqual({ visible: commits.slice(0, 3), hiddenCount: 1 });
    expect(filterTimeline(commits, "docs", false)).toEqual({ visible: commits, hiddenCount: 0 });
  });

  it("finds the next changed commit and falls back to the previous one at the end", () => {
    expect(nearestFlowChange(commits, "docs")).toEqual({ sha: "call", direction: "next" });
    expect(nearestFlowChange(commits, "readme")).toEqual({ sha: "call", direction: "previous" });
    expect(nearestFlowChange([commits[1]], "docs")).toBeNull();
  });

  it("moves along the oldest-first list and stops at either end", () => {
    expect(moveSelection(1, "ArrowUp", 3)).toBe(0);
    expect(moveSelection(1, "ArrowDown", 3)).toBe(2);
    expect(moveSelection(0, "ArrowUp", 3)).toBe(0);
    expect(moveSelection(2, "ArrowDown", 3)).toBe(2);
    expect(moveSelection(-1, "ArrowDown", 0)).toBe(-1);
  });

  it("resolves a unique prefix or falls back to the newest commit", () => {
    const commits = [{ sha: "abc1" }, { sha: "abc2" }, { sha: "def3" }];
    expect(resolveCommit(commits, "abc1")).toBe(commits[0]);
    expect(resolveCommit(commits, "def")).toBe(commits[2]);
    expect(resolveCommit(commits, "abc")).toBe(commits[2]);
    expect(resolveCommit(commits, "unknown")).toBe(commits[2]);
    expect(resolveCommit(commits, null)).toBe(commits[2]);
    expect(resolveCommit([], null)).toBeUndefined();
  });
});
