import { describe, expect, it } from "vitest";
import { legacyRepoRedirect, parsePath, repoPath } from "./router";

describe("parsePath", () => {
  it("matches the landing and viewer paths", () => {
    expect(parsePath("/")).toEqual({ page: "landing" });
    expect(parsePath("/repo/x")).toEqual({ page: "viewer", id: "x" });
    expect(parsePath("/repo/Flagsmith__flagsmith")).toEqual({ page: "viewer", id: "Flagsmith__flagsmith" });
    expect(parsePath(repoPath("shop demo"))).toEqual({ page: "viewer", id: "shop demo" });
  });

  it.each(["/unknown", "/repo/", "/repo/x/extra", "/repo/x%2Fy", "/repo/%", "/repo/.."])("rejects %s", (path) => {
    expect(parsePath(path)).toEqual({ page: "not-found" });
  });
});

describe("legacyRepoRedirect", () => {
  it("moves the repo into the path and preserves commit and view", () => {
    expect(legacyRepoRedirect("/", "?repo=X&commit=Y")).toBe("/repo/X?commit=Y");
    expect(legacyRepoRedirect("/", "?view=overlay_summary&repo=shop+demo&commit=f376f9c"))
      .toBe("/repo/shop%20demo?view=overlay_summary&commit=f376f9c");
    expect(legacyRepoRedirect("/", "?repo=X")).toBe("/repo/X");
  });

  it("leaves other URLs alone", () => {
    expect(legacyRepoRedirect("/", "?commit=Y")).toBeNull();
    expect(legacyRepoRedirect("/", "?repo=..")).toBeNull();
    expect(legacyRepoRedirect("/repo/X", "?repo=other")).toBeNull();
  });
});
