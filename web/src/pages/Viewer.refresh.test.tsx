// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { ImportStatus, Repo, TimelineCommit } from "../types";

vi.mock("../config", () => ({ apiUrl: "https://flow.test" }));
vi.mock("../flags", async (importOriginal) => ({
  ...await importOriginal<typeof import("../flags")>(),
  useCodeFlowFlags: () => ({
    ready: true, flowView: "overlay", flagsmithMode: false, liveFlagPanel: false,
    variantPreview: false, reviewerId: "demo",
    viewOverride: null, directionOverride: null,
  }),
}));
vi.mock("../useDiff", () => ({
  useDiff: () => ({ status: "loading" }),
  useDiffLayout: () => ({ layout: { status: "loading" }, hasCollapsedContext: false }),
}));

const id = "Demo__shop";
const repoPath = `/api/repos/${id}`;
const initial: TimelineCommit = {
  sha: "abc123", message: "Update checkout", author: "Demo", date: "2026-11-26T10:00:00Z",
  parents: [], summary: "", stats: {
    nodes_added: 1, nodes_removed: 0, nodes_changed: 0, edges_added: 0, edges_removed: 0,
  },
};

const analyzing: ImportStatus = {
  id, name: "Demo/shop", status: "analyzing", message: "Analyzing repository",
  current: 3, total: 5, seconds: 1, warning: null, error: null, new_commits: null,
};

let root: Root;
let container: HTMLDivElement;
let repo: Repo;
let commits: TimelineCommit[];
let status: ImportStatus;
let commitQueries: string[];
const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", mockFetch);
  window.history.replaceState(null, "", `/repo/${id}?view=overlay#review`);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  repo = {
    id, name: "Demo/shop", url: "https://github.com/Demo/shop", branch: "main", subdir: "shop",
    status: "ready", message: "Ready", warning: null, commit_count: 1,
  };
  commits = [initial];
  status = analyzing;
  commitQueries = [];
  mockFetch.mockReset().mockImplementation(async (input) => {
    switch (new URL(String(input)).pathname) {
      case "/api/repos": return Response.json([repo]);
      case `${repoPath}/commits`:
        commitQueries.push(window.location.search);
        return Response.json({ repo: repo.name, branch: repo.branch, commits });
      case `${repoPath}/refresh`: return Response.json({ id, status: "queued" }, { status: 202 });
      case `${repoPath}/status`: return Response.json(status);
      default: throw new Error(`Unexpected request: ${String(input)}`);
    }
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function openViewer() {
  return act(async () => root.render(<App />));
}

function button() {
  const control = container.querySelector<HTMLButtonElement>(".viewer-header .commit-refresh button");
  if (!control) throw new Error("Missing check for new commits button");
  return control;
}

function readFeedback(role = "status") {
  return container.querySelector(`.commit-refresh [role="${role}"]`)?.textContent;
}

function click(element: HTMLElement) {
  return act(async () => element.click());
}

function poll() {
  return act(async () => vi.advanceTimersByTimeAsync(1000));
}

function callsTo(path: string) {
  return mockFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === path);
}

describe("viewer commit refresh", () => {
  it("hides the button for a local repo", async () => {
    repo.url = null;
    await openViewer();
    expect(container.textContent).not.toContain("Check for new commits");
  });

  it("waits for a click and shows progress with the button disabled", async () => {
    await openViewer();
    expect(button().textContent).toBe("Check for new commits");
    expect(button().disabled).toBe(false);
    expect(readFeedback()).toBeUndefined();
    await poll();
    expect(callsTo(`${repoPath}/status`)).toHaveLength(0);
    expect(callsTo(`${repoPath}/refresh`)).toHaveLength(0);

    await click(button());
    expect(callsTo(`${repoPath}/refresh`)).toEqual([
      [`https://flow.test${repoPath}/refresh`, expect.objectContaining({ method: "POST" })],
    ]);
    expect(button().disabled).toBe(true);
    expect(readFeedback()).toBe("Checking for new commits…");
    await poll();
    expect(button().disabled).toBe(true);
    expect(readFeedback()).toBe("Analyzing commit 3 of 5");

    await act(async () => root.render(null));
    await poll();
    expect(callsTo(`${repoPath}/status`)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports up to date and stops polling", async () => {
    status = { ...analyzing, status: "ready", new_commits: 0 };
    await openViewer();
    await click(button());
    await poll();
    expect(readFeedback()).toBe("Up to date");
    expect(button().disabled).toBe(false);
    await poll();
    expect(callsTo(`${repoPath}/status`)).toHaveLength(1);
    expect(readFeedback()).toBe("Up to date");
  });

  it.each([1, 2])("loads new history and keeps the current review (count %i)", async (count) => {
    await openViewer();
    const historyLength = window.history.length;
    const flow = container.querySelector("#flow-title");
    const source = container.querySelector("#code-pane-title");
    const sourceButton = container.querySelector<HTMLButtonElement>('[aria-controls="source-content"]')!;
    const divider = container.querySelector('[role="separator"]');
    const stepButton = [...container.querySelectorAll("button")].find(({ textContent }) => textContent?.includes("2 steps"))!;
    await click(stepButton);
    await click(sourceButton);
    expect(stepButton.getAttribute("aria-pressed")).toBe("true");

    await click(button());
    status = { ...analyzing, status: "ready", new_commits: count };
    repo.name = "Demo/updated-shop";
    const additions = Array.from({ length: count }, (_, index) => ({
      ...initial, sha: `def12${index}`, message: `New checkout change ${index + 1}`,
    }));
    commits = [initial, ...additions];
    await poll();

    expect(readFeedback()).toBe(count === 1 ? "1 new commit" : "2 new commits");
    expect(button().disabled).toBe(false);
    expect(commitQueries).toEqual(["?view=overlay", "?view=overlay&commit=abc123"]);
    expect(callsTo("/api/repos")).toHaveLength(2);
    expect(container.querySelector(".viewer-header h1")?.textContent).toBe(repo.name);
    const timeline = container.querySelector(".timeline");
    expect(timeline?.textContent).toContain(`New checkout change ${count}`);
    expect(timeline?.querySelector('[aria-current="true"]')?.textContent).toContain(initial.message);
    expect(window.location.search).toBe("?view=overlay&commit=abc123");
    expect(window.location.hash).toBe("#review");
    expect(window.history.length).toBe(historyLength);
    expect(container.querySelector("#flow-title")).toBe(flow);
    expect(container.querySelector("#code-pane-title")).toBe(source);
    expect(sourceButton.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="separator"]')).toBe(divider);
    expect(stepButton.getAttribute("aria-pressed")).toBe("true");

    const newest = [...(timeline?.querySelectorAll("button") ?? [])]
      .find((entry) => entry.textContent?.includes(`New checkout change ${count}`))!;
    await click(newest);
    expect(readFeedback()).toBeUndefined();
  });

  it("keeps the existing data after an error and allows retry", async () => {
    status = { ...analyzing, status: "error", error: "Repository not found or not public" };
    await openViewer();
    await click(button());
    await poll();
    expect(readFeedback("alert")).toBe("Couldn't check for new commits: Repository not found or not public");
    expect(button().disabled).toBe(false);
    expect(container.querySelector(".timeline")?.textContent).toContain(initial.message);
    expect(callsTo(`${repoPath}/commits`)).toHaveLength(1);
    await poll();
    expect(callsTo(`${repoPath}/status`)).toHaveLength(1);

    status = { ...analyzing, status: "ready", new_commits: 0 };
    await click(button());
    expect(readFeedback("alert")).toBeUndefined();
    expect(button().disabled).toBe(true);
    await poll();
    expect(readFeedback()).toBe("Up to date");
    expect(callsTo(`${repoPath}/refresh`)).toHaveLength(2);
  });
});
