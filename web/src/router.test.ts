import { describe, expect, it } from "vitest";
import { githubRepoPath, legacyRepoRedirect, parsePath, repoPath } from "./router";

describe("parsePath", () => {
  it("matches the landing and viewer paths", () => {
    expect(parsePath("/")).toEqual({ page: "landing" });
    expect(parsePath("/repo/x")).toEqual({ page: "viewer", id: "x" });
    expect(parsePath("/repo/Flagsmith__flagsmith")).toEqual({ page: "viewer", id: "Flagsmith__flagsmith" });
    expect(parsePath(repoPath("review fixture"))).toEqual({ page: "viewer", id: "review fixture" });
  });

  it("matches the sign-in page", () => {
    expect(parsePath("/signin")).toEqual({ page: "signin" });
    expect(parsePath("/signin/")).toEqual({ page: "signin" });
  });

  it("matches the GitHub repos and repo details paths", () => {
    expect(parsePath("/github")).toEqual({ page: "github-repos" });
    expect(parsePath("/github/")).toEqual({ page: "github-repos" });
    expect(parsePath("/github/42")).toEqual({ page: "github-repo", repoId: 42 });
    expect(githubRepoPath(42, "feature/cart")).toBe("/github/42?branch=feature%2Fcart");
    expect(githubRepoPath(42)).toBe("/github/42");
  });

  it.each([
    "/unknown", "/signin/x", "/repo/", "/repo/x/extra", "/repo/x%2Fy", "/repo/%", "/repo/..",
    "/github/0", "/github/x", "/github/1/2", "/github/12345678901234567",
  ])("rejects %s", (path) => {
    expect(parsePath(path)).toEqual({ page: "not-found" });
  });
});

describe("legacyRepoRedirect", () => {
  it("moves the repo into the path and preserves commit and view", () => {
    expect(legacyRepoRedirect("/", "?repo=X&commit=Y")).toBe("/repo/X?commit=Y");
    expect(legacyRepoRedirect("/", "?view=overlay_summary&repo=review+fixture&commit=a9b66f5"))
      .toBe("/repo/review%20fixture?view=overlay_summary&commit=a9b66f5");
    expect(legacyRepoRedirect("/", "?repo=X")).toBe("/repo/X");
  });

  it("leaves other URLs alone", () => {
    expect(legacyRepoRedirect("/", "?commit=Y")).toBeNull();
    expect(legacyRepoRedirect("/", "?repo=..")).toBeNull();
    expect(legacyRepoRedirect("/repo/X", "?repo=other")).toBeNull();
  });
});
