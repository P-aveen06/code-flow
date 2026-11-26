import { describe, expect, it } from "vitest";
import type { ImportStatus } from "../types";
import { importProgress, validateImport } from "./importHelpers";

const fields = { url: "https://github.com/Flagsmith/flagsmith", subdir: "", maxCommits: "30" };

describe("validateImport", () => {
  it("builds the request body with the default form values", () => {
    expect(validateImport(fields)).toEqual({
      body: { url: fields.url, subdir: "", max_commits: 30 },
    });
  });

  it.each(["", "/", ".git", ".git/"])("accepts a repository URL ending in %j", (suffix) => {
    const url = fields.url + suffix;
    expect(validateImport({ url: ` ${url} `, subdir: " api/nested/ ", maxCommits: "50" })).toEqual({
      body: { url, subdir: "api/nested/", max_commits: 50 },
    });
  });

  it.each([
    "", "git@github.com:owner/repo", "http://github.com/owner/repo",
    "https://github.com.example.com/owner/repo", "https://github.com/owner", "...",
    "https://github.com/owner/repo/tree/main", "https://github.com/owner/repo?x=y",
    "https://github.com/owner/..", "https://github.com/owner/.git", "https://example.com/owner/repo",
  ])("rejects the URL %j", (url) => {
    expect(validateImport({ ...fields, url })).toMatchObject({ field: "url" });
  });

  it.each(["/api", "../api", "api/../secret", "api\\nested", "C:/api"])("rejects the subfolder %j", (subdir) => {
    expect(validateImport({ ...fields, subdir })).toMatchObject({ field: "subdir" });
  });

  it.each([1, 200])("accepts a commit count of %s", (count) => {
    expect(validateImport({ ...fields, maxCommits: String(count) })).toMatchObject({ body: { max_commits: count } });
  });

  it.each(["", "-1", "0", "1.5", "201", "many"])("rejects the commit count %j", (maxCommits) => {
    expect(validateImport({ ...fields, maxCommits })).toMatchObject({ field: "maxCommits" });
  });
});

const queued: ImportStatus = {
  id: "Flagsmith__flagsmith", name: "Flagsmith/flagsmith", status: "queued", message: "Queued",
  current: null, total: null, warning: null, error: null, seconds: 0,
};

describe("importProgress", () => {
  it("starts with the submitted status and no bar until a total is known", () => {
    expect(importProgress("queued")).toEqual({ step: 0, text: "Queued", progress: null, warning: null });
    expect(importProgress("queued", { ...queued, status: "cloning", message: "Cloning repository" }))
      .toMatchObject({ step: 1, text: "Cloning repository", progress: null });
  });

  it("shows analysis progress and the ready warning", () => {
    expect(importProgress("queued", { ...queued, status: "analyzing", current: 12, total: 50 }))
      .toMatchObject({ step: 2, text: "Analyzing commit 12 of 50", progress: { current: 12, total: 50 } });
    const warning = "No Python files found in api/. code-flow analyzes Python only for now.";
    expect(importProgress("queued", { ...queued, status: "ready", message: "Ready", current: 50, total: 50, warning }))
      .toEqual({ step: 3, text: "Ready", progress: { current: 50, total: 50 }, warning });
  });

  it("shows the readable error detail", () => {
    const error = "Repository not found or not public";
    expect(importProgress("queued", { ...queued, status: "error", message: "Error", error }))
      .toMatchObject({ step: -1, text: error, progress: null });
  });
});
