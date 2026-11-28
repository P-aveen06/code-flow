// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffViewModel, OverlayNode, TimelineCommit } from "../../../types";
import type { RepoReviewModel } from "../../hooks/useRepoReview";
import { useRepoReview } from "../../hooks/useRepoReview";
import { useReviewData } from "../../hooks/useReviewData";
import { useMe } from "../../hooks/useMe";
import { useReviewQuestion } from "../../hooks/useReviewQuestion";
import { FlowViewC } from "./FlowView";

vi.mock("../../hooks/useReviewData", () => ({ useReviewData: vi.fn() }));
vi.mock("../../hooks/useRepoReview", () => ({ useRepoReview: vi.fn() }));
vi.mock("../../hooks/useMe", () => ({ useMe: vi.fn() }));
vi.mock("../../hooks/useReviewQuestion", () => ({ useReviewQuestion: vi.fn() }));
vi.mock("../../screens", () => ({
  BranchSwitchScreen: ({ currentBranch }: { currentBranch: string }) => `Branch ${currentBranch}`,
}));
vi.mock("../../../views/Overlay", () => ({ Overlay: () => "Overlay diagram" }));
vi.mock("../../../views/SideBySide", () => ({ SideBySide: () => "Side by side diagram" }));
vi.mock("../../../views/FlowCanvas", () => ({ FlowLegend: () => "Legend" }));
vi.mock("../../../views/CodePane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../views/CodePane")>()),
  CodePane: () => "Source pane",
}));

const OLD = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function commit(sha: string, message: string, changed: number): TimelineCommit {
  return {
    sha,
    parents: [],
    author: "Zaimwa9",
    date: "2026-11-27T10:00:00Z",
    message,
    stats: { nodes_added: changed, nodes_removed: 0, nodes_changed: 0, edges_added: 0, edges_removed: 0 },
    summary: "",
  };
}

const commits = [commit(OLD, "Older commit with no flow change", 0), commit(NEW, "Newest commit with a change", 2)];

const changedNode = {
  id: "services.py:transition_experiment_status",
  kind: "function",
  name: "transition_experiment_status",
  qualname: "transition_experiment_status",
  file: "api/experimentation/services.py",
  status: "changed",
  lines_added: 15,
  lines_removed: 0,
} as unknown as OverlayNode;

const diff = {
  base: "0c37fca1234",
  head: NEW,
  summary: "Changes one function",
  flow_depth: 1,
  long_flow: false,
  diff: {},
  nodes: [changedNode],
  edges: [],
} as unknown as DiffViewModel;

let root: Root;
let container: HTMLDivElement;
let selectCommit: ReturnType<typeof vi.fn>;
let setHops: ReturnType<typeof vi.fn>;
let selectNode: ReturnType<typeof vi.fn>;
let setGuide: ReturnType<typeof vi.fn>;
let submit: ReturnType<typeof useReviewQuestion>["submit"];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  selectCommit = vi.fn();
  setHops = vi.fn();
  selectNode = vi.fn();
  setGuide = vi.fn();
  submit = vi.fn();
  vi.mocked(useReviewData).mockReturnValue({
    status: "ready",
    data: { commits, name: "Flagsmith/flagsmith", subdir: "api/", url: null, branch: "main", hasNodes: true },
  });
  vi.mocked(useMe).mockReturnValue({ me: { status: "loading" }, refresh: vi.fn(), signOut: vi.fn() });
  vi.mocked(useReviewQuestion).mockReturnValue({ canReview: true, answered: false, submit });
  vi.mocked(useRepoReview).mockReturnValue(model());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// The review model as the hook returns it. Only the fields the screen reads are real.
function model(overrides: Partial<RepoReviewModel> = {}): RepoReviewModel {
  const selected = commits[1];
  const base = {
    name: "Flagsmith/flagsmith",
    subdir: "api/",
    url: "https://github.com/Flagsmith/flagsmith",
    branch: "main",
    hasNodes: true,
    commits,
    selected,
    head: selected.sha,
    commitTitle: selected.message,
    selectCommit,
    commitHref: (sha: string) => `/repo/Flagsmith__flagsmith?commit=${sha}`,
    nextChange: null,
    refresh: null,
    checkForNewCommits: vi.fn(),
    flowChanged: true,
    view: "overlay",
    viewOverride: null,
    assignedView: null,
    viewSource: "Default",
    direction: "horizontal",
    directionOverride: null,
    assignedDirection: null,
    directionSource: "Default",
    directionReady: true,
    longFlow: false,
    flagsReady: true,
    variantPreview: false,
    hops: 1,
    setHops,
    diff,
    request: { status: "ready", data: diff },
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
    setGuide,
    guideButton: { current: null },
    reviewContext: null,
    sendsReviewEvents: false,
    onReview: vi.fn(),
    reviewKey: "review",
    selectedNode: undefined,
    selectNode,
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
    liveFlagPanel: true,
    liveStates: {},
    selectedFlag: undefined,
    selectFlag: vi.fn(),
  };
  return { ...base, ...overrides } as unknown as RepoReviewModel;
}

async function show() {
  await act(async () => root.render(<FlowViewC id="Flagsmith__flagsmith" search="" />));
}

function button(text: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
}

async function click(element: Element | undefined | null) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}

describe("flow view (flow C)", () => {
  it("shows a loading message while the commit history loads", async () => {
    vi.mocked(useReviewData).mockReturnValue({ status: "loading" });
    await show();
    expect(container.querySelector("[role=status]")?.textContent).toBe("Loading commit history…");
  });

  it("shows the error when the commit history fails", async () => {
    vi.mocked(useReviewData).mockReturnValue({ status: "error", message: "Repo not found" });
    await show();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Repo not found");
  });

  it("shows the repo, the commit, the branch and the diagram", async () => {
    await show();
    expect(container.querySelector("h1")?.textContent).toBe("Flagsmith/flagsmith");
    expect(container.querySelector(".fc-flow__commit-title")?.textContent).toBe("Newest commit with a change");
    expect(container.querySelector(".fc-flow__subdir")?.textContent).toBe("api/");
    expect(container.textContent).toContain("Branch main");
    expect(container.textContent).toContain("Overlay diagram");
    expect(container.textContent).toContain("Your repositories");
  });

  it("answers the review question with its two buttons", async () => {
    vi.mocked(useRepoReview).mockReturnValue(model({ reviewContext: { view: "overlay", reviewerId: "r", devOverride: false, repo: "x", head: NEW, base: "" } as never }));
    await show();
    expect(container.textContent).toContain("Did this diagram help you understand the change?");
    await click(button("Yes, I understand it"));
    expect(submit).toHaveBeenLastCalledWith("diff_understood");
    await click(button("No, it's confusing"));
    expect(submit).toHaveBeenLastCalledWith("diff_confusing");
  });

  it("shows the no-flow-change card with a link to the nearest commit with changes", async () => {
    vi.mocked(useRepoReview).mockReturnValue(model({
      flowChanged: false,
      nextChange: { sha: OLD, direction: "previous" },
    }));
    await show();
    expect(container.querySelector(".fc-flow__nochange-title")?.textContent).toBe("No flow change");
    const link = [...container.querySelectorAll("a")].find((item) => item.textContent?.includes("Go to the previous commit"));
    expect(link?.getAttribute("href")).toBe(`/repo/Flagsmith__flagsmith?commit=${OLD}`);
  });

  it("hides commits with no flow change by default and selects a commit from the scrubber", async () => {
    await show();
    expect(container.querySelector(".fc-flow__hidden")?.textContent).toBe("1 hidden");
    const checkbox = container.querySelector<HTMLInputElement>(".fc-flow__hide input");
    expect(checkbox?.checked).toBe(true);
    await click(checkbox);
    expect(container.querySelector(".fc-flow__hidden")).toBeNull();
    await click(container.querySelector<HTMLAnchorElement>(`a[href="/repo/Flagsmith__flagsmith?commit=${OLD}"]`));
    expect(selectCommit).toHaveBeenCalledWith(OLD);
  });

  it("changes the neighbour steps and lists changed functions", async () => {
    await show();
    await click(button("2 steps"));
    expect(setHops).toHaveBeenCalledWith(2);
    await click(container.querySelector("summary"));
    const changed = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("transition_experiment_status"));
    await click(changed);
    expect(selectNode).toHaveBeenCalledWith(changedNode);
  });

  it("opens the Flagsmith details from the info button", async () => {
    await show();
    expect(container.textContent).not.toContain("Flag checks are off");
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Flagsmith details"]'));
    expect(container.textContent).toContain("Flag checks are off (flagsmith_mode)");
  });

  it("dismisses the diagram guide", async () => {
    vi.mocked(useRepoReview).mockReturnValue(model({ guideOpen: true }));
    await show();
    expect(container.textContent).toContain("What am I looking at?");
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]'));
    expect(setGuide).toHaveBeenCalledWith(false);
  });
});
