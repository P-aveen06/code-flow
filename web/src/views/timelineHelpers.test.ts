import { describe, expect, it } from "vitest";
import { formatStats, moveSelection, resolveCommit } from "./timelineHelpers";

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
