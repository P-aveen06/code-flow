// @vitest-environment happy-dom

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewContext } from "../../../events";
import type { TimelineCommit } from "../../../types";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { useMe } from "../../hooks/useMe";
import { useRepoReview } from "../../hooks/useRepoReview";
import { useReviewData } from "../../hooks/useReviewData";
import type { ReviewData } from "../../hooks/useReviewData";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState } from "../../types";
import { FlowViewA } from "./FlowView";

vi.mock("../../hooks/useReviewData", () => ({ useReviewData: vi.fn() }));
vi.mock("../../hooks/useRepoReview", () => ({ useRepoReview: vi.fn() }));
vi.mock("../../hooks/useMe", () => ({ useMe: vi.fn() }));
vi.mock("../../../events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../events")>()),
  recordDiffViewed: vi.fn(),
}));
vi.mock("../../../views/Overlay", () => ({ Overlay: () => "Overlay diagram" }));
vi.mock("../../../views/SideBySide", () => ({ SideBySide: () => "Side-by-side diagram" }));
vi.mock("../../../views/OverlaySummary", () => ({ OverlaySummary: () => "Overlay summary" }));
vi.mock("../../../views/FlowCanvas", () => ({ FlowLegend: () => "Legend" }));
vi.mock("../../../views/CodePane", () => ({ CodePane: () => "Code pane" }));
vi.mock("../../../views/FlagsmithPanel", () => ({ FlagsmithPanel: () => "Flagsmith panel" }));
vi.mock("../../screens", () => ({ BranchSwitchScreen: branchSwitchScreen }));

// The branch switch is another piece's screen here; the spy records the branch it was given.
const branchSwitchScreen = vi.hoisted(() => vi.fn((_props: { repoId: string; currentBranch: string }) => "Branch switch"));

const stats = (added: number, removed = 0, changed = 0) => ({
  nodes_added: added, nodes_removed: removed, nodes_changed: changed, edges_added: 0, edges_removed: 0,
});

// Oldest first, as the store keeps them. The first commit has no flow change, so it is hidden by default.
const commits: TimelineCommit[] = [
  { sha: "1111111", parents: [], author: "Ada", date: "2026-11-20T10:00:00Z", message: "docs: tidy", stats: stats(0), summary: "" },
  { sha: "2222222", parents: [], author: "Ada", date: "2026-11-21T10:00:00Z", message: "fix(api): add the thing", stats: stats(1, 0, 1), summary: "" },
  { sha: "3333333", parents: [], author: "Lin", date: "2026-11-22T10:00:00Z", message: "feat(api): more", stats: stats(2), summary: "" },
];

const appState: AppFlowState = {
  ready: true, reviewerId: "demo", flow: null, pieces: { ...TODAY_PIECES }, exposed: false, preview: false,
};

// The review model as useRepoReview returns it, with the defaults of a commit that has a flow change.
function reviewModel(overrides: Record<string, unknown> = {}) {
  const model = {
    name: "Flagsmith/flagsmith",
    subdir: "api",
    url: "https://github.com/Flagsmith/flagsmith",
    branch: "main",
    hasNodes: true,
    commits,
    selected: commits[1],
    head: "2222222",
    commitTitle: "fix(api): add the thing",
    selectCommit: vi.fn(),
    commitHref: (sha: string) => `/repo/Flagsmith__flagsmith@${sha}`,
    nextChange: null,
    refresh: null,
    checkForNewCommits: vi.fn(),
    flowChanged: true,
    view: "overlay",
    viewOverride: undefined,
    assignedView: "overlay",
    viewSource: "default",
    direction: "horizontal",
    directionOverride: undefined,
    assignedDirection: "horizontal",
    directionSource: "default",
    directionReady: true,
    longFlow: false,
    flagsReady: true,
    variantPreview: false,
    hops: 1,
    setHops: vi.fn(),
    diff: { base: "1111111", head: "2222222", nodes: [], summary: {} },
    request: { status: "ready", data: {} },
    layout: { status: "ready", data: {} },
    currentLayout: {},
    hasCollapsedContext: false,
    contextExpanded: false,
    toggleContext: vi.fn(),
    expandModule: vi.fn(),
    layoutPositions: {},
    fullscreen: { panel: { current: null }, active: false, maximized: false, toggle: vi.fn() },
    markRendered: vi.fn(),
    guideOpen: false,
    setGuide: vi.fn(),
    reviewContext: null,
    sendsReviewEvents: false,
    onReview: vi.fn(),
    reviewKey: "review",
    selectedNode: null,
    selectNode: vi.fn(),
    selectedCheck: null,
    openCheck: vi.fn(),
    clearSelection: vi.fn(),
    sourceOpen: false,
    setSourceOpen: vi.fn(),
    findings: { status: "ready", data: [] },
    flags: [],
    flagsmithMode: false,
    liveStates: {},
    selectedFlag: null,
    selectFlag: vi.fn(),
    ...overrides,
  };
  return model;
}

type Model = ReturnType<typeof reviewModel>;

function givenReview(overrides: Record<string, unknown> = {}): Model {
  const model = reviewModel(overrides);
  vi.mocked(useRepoReview).mockReturnValue(model as unknown as ReturnType<typeof useRepoReview>);
  return model;
}

const reviewContext = {
  view: "overlay", reviewerId: "demo", devOverride: false, repo: "Flagsmith__flagsmith", head: "2222222", base: "1111111",
} as unknown as ReviewContext;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(useReviewData).mockReturnValue({ status: "ready", data: {} as ReviewData });
  vi.mocked(useMe).mockReturnValue({
    me: { status: "ready", data: { configured: true, signed_in: false } },
    refresh: vi.fn(),
    signOut: vi.fn(),
  } as unknown as ReturnType<typeof useMe>);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function show(element: ReactElement) {
  await act(async () => root.render(<AppFlowTestProvider value={appState}>{element}</AppFlowTestProvider>));
}

async function click(element: HTMLElement | null) {
  if (!element) throw new Error("Expected an element to click");
  await act(async () => element.click());
}

function buttonText(text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.trim() === text) ?? null;
}

async function renderFlow(overrides: Record<string, unknown> = {}) {
  const model = givenReview(overrides);
  await show(<FlowViewA id="Flagsmith__flagsmith" search="" />);
  return model;
}

describe("flow view", () => {
  it("shows the loading state while the review loads", async () => {
    vi.mocked(useReviewData).mockReturnValue({ status: "loading" });
    await show(<FlowViewA id="Flagsmith__flagsmith" search="" />);

    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading commit history…");
  });

  it("shows the review's load error", async () => {
    vi.mocked(useReviewData).mockReturnValue({ status: "error", message: "Repo not found" });
    await show(<FlowViewA id="Flagsmith__flagsmith" search="" />);

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Repo not found");
  });

  it("shows the commit, its counts and the branch switch", async () => {
    await renderFlow();

    expect(container.querySelector(".fa-flowview__prefix")?.textContent).toBe("fix(api):");
    expect(container.querySelector("h1")?.textContent).toBe("Add the thing");
    expect(container.querySelector(".fa-flowview__subdir")?.textContent).toContain("api/");
    const counts = Array.from(container.querySelectorAll(".fa-flowview__count dd")).map((item) => item.textContent);
    expect(counts).toEqual(["1", "0", "1"]);
    expect(branchSwitchScreen.mock.calls.at(-1)?.[0]).toMatchObject({
      repoId: "Flagsmith__flagsmith", currentBranch: "main",
    });
  });

  it("draws the overlay with its legend, and the summary only for the summary view", async () => {
    await renderFlow();
    expect(container.textContent).toContain("Overlay diagram");
    expect(container.textContent).toContain("Legend");
    expect(container.textContent).not.toContain("Overlay summary");

    await renderFlow({ view: "overlay_summary" });
    expect(container.textContent).toContain("Overlay summary");
  });

  it("draws side by side when the view says so", async () => {
    await renderFlow({ view: "side_by_side" });

    expect(container.textContent).toContain("Side-by-side diagram");
    expect(container.textContent).not.toContain("Overlay diagram");
  });

  it("shows the no-flow-change state with a link to the nearest change", async () => {
    const model = await renderFlow({ flowChanged: false, nextChange: { sha: "1111111", direction: "older" } });

    const heading = Array.from(container.querySelectorAll("h3")).find((item) => item.textContent === "No flow change in this commit");
    expect(heading).toBeDefined();
    const link = Array.from(container.querySelectorAll("a")).find((item) => item.textContent?.includes("Go to the older commit"));
    expect(link?.getAttribute("href")).toBe("/repo/Flagsmith__flagsmith@1111111");
    expect(model.markRendered).toHaveBeenCalled();
  });

  it("answers the review question with the button and with U or C", async () => {
    const model = await renderFlow({ reviewContext });
    await click(buttonText("Yes, I understand it U"));

    expect(model.onReview).toHaveBeenCalledTimes(1);
    expect(model.onReview).toHaveBeenCalledWith(expect.objectContaining({ event: "diff_understood" }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Thanks");
  });

  it("answers the review question with the C key", async () => {
    const model = await renderFlow({ reviewContext });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    });

    expect(model.onReview).toHaveBeenCalledWith(expect.objectContaining({ event: "diff_confusing" }));
  });

  it("steps through the commits with the arrow keys and the Newer button", async () => {
    // Visible commits, newest first: 3333333 then 2222222 (the one shown). Newer is 3333333.
    const model = await renderFlow();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    });
    expect(model.selectCommit).toHaveBeenCalledWith("3333333");

    await click(buttonText("Newer"));
    expect(model.selectCommit).toHaveBeenCalledTimes(2);
    expect(buttonText("Older")?.disabled).toBe(true);
  });

  it("sets the neighbours, expands the context and checks for new commits", async () => {
    const model = await renderFlow({ hasCollapsedContext: true });
    await click(buttonText("2 steps"));
    expect(model.setHops).toHaveBeenCalledWith(2);

    await click(buttonText("Expand all context"));
    expect(model.toggleContext).toHaveBeenCalledTimes(1);

    await click(buttonText("Check for new commits"));
    expect(model.checkForNewCommits).toHaveBeenCalledTimes(1);
  });

  it("opens the source drawer and lists the commits with flow changes", async () => {
    const model = await renderFlow();
    await click(buttonText("Source code"));
    expect(model.setSourceOpen).toHaveBeenCalledWith(true);

    await click(buttonText("All commits (2 with flow changes)"));
    expect(Array.from(container.querySelectorAll("h2")).map((item) => item.textContent)).toContain("Commits");
    expect(container.querySelectorAll(".fa-flowview__row")).toHaveLength(2);
    expect(container.textContent).toContain("1 hidden");

    await click(container.querySelector<HTMLElement>('input[type="checkbox"]'));
    expect(container.querySelectorAll(".fa-flowview__row")).toHaveLength(3);
  });

  it("keeps the source drawer shut until a function is selected", async () => {
    const drawer = () => container.querySelector<HTMLElement>("#fa-flowview-source");
    await renderFlow({ sourceOpen: true });
    expect(drawer()?.hidden).toBe(true);

    await renderFlow({ sourceOpen: true, selectedNode: { id: "pkg.mod.fn", file: "pkg/mod.py" } });
    expect(drawer()?.hidden).toBe(false);
  });

  it("shows the guide and dismisses it", async () => {
    const model = await renderFlow({ guideOpen: true });
    expect(container.textContent).toContain("What am I looking at?");

    await click(container.querySelector<HTMLElement>('[aria-label="Dismiss"]'));
    expect(model.setGuide).toHaveBeenCalledWith(false);
  });

  it("shows the no-Python state when the repo has no nodes", async () => {
    await renderFlow({ hasNodes: false });

    expect(container.textContent).toContain("No Python code found in api/.");
  });

  it("shows a diff request error", async () => {
    await renderFlow({ request: { status: "error", message: "Diff failed" } });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Diff failed");
  });
});
