// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ReviewOutcome } from "../../../events";
import type { FlowLayout } from "../../../layout/elk";
import type { DiffViewModel, TimelineCommit } from "../../../types";
import { useMe } from "../../hooks/useMe";
import { useRepoReview } from "../../hooks/useRepoReview";
import type { RepoReviewModel } from "../../hooks/useRepoReview";
import { useReviewData } from "../../hooks/useReviewData";
import type { ReviewData } from "../../hooks/useReviewData";
import { useReviewQuestion } from "../../hooks/useReviewQuestion";
import { FlowViewB } from "./FlowView";

vi.mock("../../hooks/useReviewData", () => ({ useReviewData: vi.fn() }));
vi.mock("../../hooks/useRepoReview", () => ({ useRepoReview: vi.fn() }));
vi.mock("../../hooks/useMe", () => ({ useMe: vi.fn() }));
vi.mock("../../hooks/useReviewQuestion", () => ({ useReviewQuestion: vi.fn() }));
vi.mock("../../screens", () => ({
  BranchSwitchScreen: ({ currentBranch }: { currentBranch: string }) => `Branch ${currentBranch}`,
}));
vi.mock("../../../views/CodePane", () => ({ CodePane: () => "Source pane", ChangedFunctions: () => "Changed functions" }));
vi.mock("../../../views/Overlay", () => ({ Overlay: () => "Overlay diagram" }));
vi.mock("../../../views/SideBySide", () => ({ SideBySide: () => "Side by side diagram" }));
vi.mock("../../../views/OverlaySummary", () => ({ OverlaySummary: () => "Summary strip" }));
vi.mock("../../../views/FlowCanvas", () => ({ FlowLegend: () => "Legend" }));
vi.mock("../../../views/FlagsmithPanel", () => ({ FlagsmithPanel: () => "Flagsmith panel" }));

function stats(added: number) {
  return { nodes_added: added, nodes_removed: 0, nodes_changed: 0, edges_added: 0, edges_removed: 0 };
}

function commit(sha: string, message: string, added: number): TimelineCommit {
  return { sha, message, summary: "", parents: [], author: "Demo", date: "2026-11-26T10:00:00Z", stats: stats(added) };
}

// Newest first, as the history lists them. The second commit changes no flow.
const commits = [
  commit("1111111aaaa", "Update checkout", 1),
  commit("2222222bbbb", "Tidy docs", 0),
  commit("3333333cccc", "Add cart", 2),
];

const reviewData: ReviewData = {
  commits,
  name: "Flagsmith/flagsmith",
  subdir: null,
  url: "https://github.com/Flagsmith/flagsmith",
  branch: "main",
  hasNodes: true,
};

const flowLayout = {} as FlowLayout;
// The diagram is mocked, so only the fields the screen reads are given.
const diff = { base: "3333333", head: "1111111", summary: "", nodes: [], edges: [] } as unknown as DiffViewModel;

// The review model the hook returns. Only the fields the screen reads are set; the rest are not used here.
function model(overrides: Partial<RepoReviewModel> = {}): RepoReviewModel {
  return {
    name: "Flagsmith/flagsmith",
    subdir: null,
    url: "https://github.com/Flagsmith/flagsmith",
    branch: "main",
    hasNodes: true,
    commits,
    selected: commits[0],
    head: commits[0].sha,
    commitTitle: "Update checkout",
    selectCommit: vi.fn(),
    commitHref: (sha: string) => `/repo/Flagsmith__flagsmith?commit=${sha}`,
    nextChange: null,
    refresh: null,
    checkForNewCommits: vi.fn(),
    flowChanged: true,
    view: "overlay",
    viewOverride: null,
    assignedView: null,
    viewSource: "default",
    direction: "vertical",
    directionOverride: null,
    assignedDirection: null,
    directionSource: "default",
    directionReady: true,
    longFlow: false,
    flagsReady: true,
    variantPreview: false,
    hops: 1,
    setHops: vi.fn(),
    diff,
    request: { status: "ready", data: diff },
    layout: { status: "ready", data: flowLayout },
    currentLayout: flowLayout,
    hasCollapsedContext: false,
    contextExpanded: false,
    toggleContext: vi.fn(),
    expandModule: vi.fn(),
    layoutPositions: {} as RepoReviewModel["layoutPositions"],
    fullscreen: { panel: { current: null }, active: false, maximized: false, toggle: vi.fn() },
    markRendered: vi.fn(),
    guideOpen: false,
    setGuide: vi.fn(),
    reviewContext: null,
    sendsReviewEvents: false,
    onReview: vi.fn(),
    reviewKey: "review",
    selectedNode: undefined,
    selectNode: vi.fn(),
    selectedCheck: undefined,
    openCheck: vi.fn(),
    clearSelection: vi.fn(),
    sourceOpen: true,
    setSourceOpen: vi.fn(),
    workspace: { current: null },
    sourceHeading: { current: null },
    findings: { status: "loading" },
    flags: undefined,
    flagsmithMode: false,
    liveFlagPanel: false,
    liveStates: new Map(),
    selectedFlag: undefined,
    selectFlag: vi.fn(),
    ...overrides,
  } as RepoReviewModel;
}

let root: Root;
let container: HTMLDivElement;
let submit: Mock<(outcome: ReviewOutcome) => void>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  submit = vi.fn<(outcome: ReviewOutcome) => void>();
  vi.mocked(useReviewData).mockReturnValue({ status: "ready", data: reviewData });
  vi.mocked(useRepoReview).mockReturnValue(model());
  vi.mocked(useMe).mockReturnValue({ me: { status: "loading" }, refresh: vi.fn(), signOut: vi.fn(async () => undefined) });
  vi.mocked(useReviewQuestion).mockReturnValue({ canReview: true, answered: false, submit });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show() {
  await act(async () => root.render(<FlowViewB id="Flagsmith__flagsmith" search="" />));
}

function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

function rows() {
  return [...container.querySelectorAll<HTMLAnchorElement>(".fb-flowview__row")];
}

describe("flow view states", () => {
  it("shows the loading message while the commit history loads", async () => {
    vi.mocked(useReviewData).mockReturnValue({ status: "loading" });
    await show();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading commit history…");
  });

  it("shows the load error", async () => {
    vi.mocked(useReviewData).mockReturnValue({ status: "error", message: "Could not reach the server." });
    await show();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not reach the server.");
  });

  it("shows the no-Python state and hides the review question", async () => {
    vi.mocked(useRepoReview).mockReturnValue(model({ hasNodes: false }));
    await show();
    expect(container.textContent).toContain("No Python code found in this repository. code-flow analyzes Python only for now.");
    expect(container.textContent).not.toContain("Did this diagram help you understand the change?");
  });
});

describe("diagram", () => {
  it("renders the diagram, legend and source pane for the view", async () => {
    await show();
    expect(container.textContent).toContain("Overlay diagram");
    expect(container.textContent).toContain("Legend");
    expect(container.textContent).toContain("Source pane");
  });

  it("explains a commit with no flow change and links to the nearest one", async () => {
    const markRendered = vi.fn();
    vi.mocked(useRepoReview).mockReturnValue(model({
      flowChanged: false,
      nextChange: { sha: "3333333cccc", direction: "next" },
      markRendered,
    }));
    await show();
    expect(container.querySelector(".fb-flowview__card h2")?.textContent).toBe("No flow change");
    expect(container.querySelector<HTMLAnchorElement>(".fb-flowview__card a")?.getAttribute("href"))
      .toBe("/repo/Flagsmith__flagsmith?commit=3333333cccc");
    expect(container.textContent).toContain("Go to the next commit with flow changes");
    expect(markRendered).toHaveBeenCalled();
  });
});

describe("commits", () => {
  it("lists the commits, marks the one under review and shows the branch switch", async () => {
    await show();
    expect(container.querySelector("h1")?.textContent).toBe("Update checkout");
    expect(container.textContent).toContain("Branch main");
    // The no-change commit is hidden by default, so two rows show.
    expect(rows()).toHaveLength(2);
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    expect(container.querySelector(".fb-flowview__filter")?.textContent).toContain("1 hidden");
  });

  it("shows commits with no flow change when the filter is off", async () => {
    await show();
    const filter = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => filter?.click());
    expect(filter?.checked).toBe(false);
    expect(rows()).toHaveLength(3);
  });

  it("selects a commit when its row is clicked", async () => {
    const selectCommit = vi.fn();
    vi.mocked(useRepoReview).mockReturnValue(model({ selectCommit }));
    await show();
    await act(async () => rows()[1].click());
    expect(selectCommit).toHaveBeenCalledWith("3333333cccc");
  });

  it("steps through the commits with the arrow keys", async () => {
    const selectCommit = vi.fn();
    vi.mocked(useRepoReview).mockReturnValue(model({ selectCommit }));
    await show();
    // Already at the newest commit, so ↑ selects nothing.
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" })));
    expect(selectCommit).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })));
    expect(selectCommit).toHaveBeenCalledWith("3333333cccc");
  });

  it("sets how many neighbour steps the diagram shows", async () => {
    const setHops = vi.fn();
    vi.mocked(useRepoReview).mockReturnValue(model({ setHops }));
    await show();
    await act(async () => button("2 steps").click());
    expect(setHops).toHaveBeenCalledWith(2);
  });

  it("checks GitHub for new commits", async () => {
    const checkForNewCommits = vi.fn();
    vi.mocked(useRepoReview).mockReturnValue(model({ checkForNewCommits }));
    await show();
    await act(async () => button("Check for new commits").click());
    expect(checkForNewCommits).toHaveBeenCalled();
  });
});

describe("review question", () => {
  it("sends the answer through submit with the same outcome names as today", async () => {
    await show();
    expect(container.querySelector("#review-question")?.textContent).toBe("Did this diagram help you understand the change?");
    await act(async () => button("Yes, I understand it U").click());
    expect(submit).toHaveBeenLastCalledWith("diff_understood");
    await act(async () => button("No, it's confusing C").click());
    expect(submit).toHaveBeenLastCalledWith("diff_confusing");
  });

  it("shows the thanks message in place of the answers once answered", async () => {
    vi.mocked(useReviewQuestion).mockReturnValue({ canReview: false, answered: true, submit });
    await show();
    expect(container.querySelector('.fb-flowview__thanks[role="status"]')?.textContent).toContain("Thanks — recorded.");
    expect(container.querySelector(".fb-flowview__answers")).toBeNull();
  });
});
