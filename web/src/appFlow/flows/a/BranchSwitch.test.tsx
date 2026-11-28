// @vitest-environment happy-dom

import { act, useState } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubCommitList, RepoBranches } from "../../../types";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { useBranchSwitch } from "../../hooks/useBranchSwitch";
import type { BranchSwitch } from "../../hooks/useBranchSwitch";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState } from "../../types";
import { BranchSwitchA } from "./BranchSwitch";

vi.mock("../../hooks/useBranchSwitch", () => ({ useBranchSwitch: vi.fn() }));

const repoId = "Flagsmith__flagsmith";

const branchList: RepoBranches = {
  repo: repoId,
  full_name: "Flagsmith/flagsmith",
  default_branch: "main",
  current_branch: "main",
  branches: ["main", "feat/snowflake-dialect", "release/2.296"],
  analyzed: [
    { branch: "main", id: repoId, status: "ready" },
    { branch: "release/2.296", id: "Flagsmith__flagsmith@release~2.296", status: "ready" },
  ],
};

const commitList: GitHubCommitList = {
  branch: "feat/snowflake-dialect",
  limit: 20,
  commits: [
    {
      sha: "abcdef1234567", message: "feat: add the snowflake dialect", author: "Ada",
      date: "2026-11-20T10:00:00Z", url: "https://github.com/Flagsmith/flagsmith/commit/abcdef1",
    },
    {
      sha: "1234567abcdef", message: "test: cover it", author: "Lin",
      date: "2026-11-21T10:00:00Z", url: "https://github.com/Flagsmith/flagsmith/commit/1234567",
    },
  ],
};

// A stand-in for useBranchSwitch that keeps the selected branch in state, as the real hook does.
function stubSwitch(options: { commits?: BranchSwitch["commits"]; progress?: BranchSwitch["progress"]; error?: string | null } = {}) {
  const selectSpy = vi.fn();
  const analyzeSpy = vi.fn();
  vi.mocked(useBranchSwitch).mockImplementation(() => {
    const [selected, setSelected] = useState<string | null>(null);
    return {
      info: { status: "ready", data: branchList },
      selected,
      select(name: string) {
        selectSpy(name);
        setSelected(name);
      },
      commits: options.commits ?? { status: "ready", data: commitList },
      analyze: analyzeSpy,
      progress: options.progress ?? null,
      error: options.error ?? null,
      githubRepoId: 1,
    };
  });
  return { selectSpy, analyzeSpy };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const appState: AppFlowState = {
  ready: true, reviewerId: "demo", flow: null, pieces: { ...TODAY_PIECES }, exposed: false, preview: false,
};

async function show(element: ReactElement) {
  await act(async () => root.render(<AppFlowTestProvider value={appState}>{element}</AppFlowTestProvider>));
}

async function click(element: HTMLElement | null) {
  if (!element) throw new Error("Expected an element to click");
  await act(async () => element.click());
}

async function press(key: string, target: EventTarget = document) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function trigger() {
  return container.querySelector<HTMLButtonElement>(".fa-branch__trigger");
}

function dialog() {
  return container.querySelector<HTMLElement>('[role="dialog"]');
}

function rows() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".fa-branch__row"));
}

function rowNamed(name: string) {
  return rows().find((row) => row.textContent?.includes(name)) ?? null;
}

function buttonText(text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.trim() === text) ?? null;
}

function closeButton() {
  return container.querySelector<HTMLElement>('[aria-label="Close"]');
}

describe("branch switch", () => {
  it("shows the current branch on the trigger and opens the dialog", async () => {
    stubSwitch();
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    expect(trigger()?.getAttribute("aria-label")).toBe("Switch branch, current branch main");
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();

    await click(trigger());
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector("h2")?.textContent).toBe("Switch branch");
    expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
    expect(vi.mocked(useBranchSwitch).mock.lastCall).toEqual([repoId, true]);
  });

  it("lists the branches with the default, current and analyzed state", async () => {
    stubSwitch();
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    await click(trigger());

    expect(rows()).toHaveLength(3);
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    expect(rows()[0].textContent).toContain("Default");
    expect(rows()[0].textContent).toContain("Analyzed");
    expect(rowNamed("feat/snowflake-dialect")?.textContent).toContain("Not analyzed");
    expect(rowNamed("release/2.296")?.textContent).toContain("Analyzed");
    expect(container.textContent).toContain("Step 1 of 2");
  });

  it("selects a branch, shows its latest commits and starts the analysis", async () => {
    const { selectSpy, analyzeSpy } = stubSwitch();
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    await click(trigger());
    await click(rowNamed("feat/snowflake-dialect"));

    expect(selectSpy).toHaveBeenCalledWith("feat/snowflake-dialect");
    expect(container.querySelector("h3")?.textContent).toBe("Latest 2 commits on feat/snowflake-dialect");
    expect(container.querySelectorAll(".fa-branch__commit")).toHaveLength(2);
    await click(buttonText("Analyze 2 commits"));
    expect(analyzeSpy).toHaveBeenCalledTimes(1);
  });

  it("opens an analyzed branch straight away", async () => {
    const { analyzeSpy } = stubSwitch();
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    await click(trigger());
    await click(rowNamed("release/2.296"));

    expect(analyzeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes on the current branch without selecting it", async () => {
    const { selectSpy } = stubSwitch();
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    await click(trigger());
    await click(rowNamed("main"));

    expect(selectSpy).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("shows the import progress with its step and bar", async () => {
    stubSwitch({ progress: { text: "Analyzing commit 12 of 20", current: 12, total: 20 } });
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    await click(trigger());

    expect(container.querySelector("h2")?.textContent).toBe("Import progress");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("60");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Analyzing");
    expect(container.textContent).toContain("Analyzing commit 12 of 20");
  });

  it("shows an analysis error with a retry", async () => {
    const { analyzeSpy } = stubSwitch({ error: "Import failed" });
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    await click(trigger());
    await click(rowNamed("feat/snowflake-dialect"));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not analyze this branch. Import failed");
    await click(buttonText("Try again"));
    expect(analyzeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    stubSwitch();
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    await click(trigger());
    await press("Escape");

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a click outside the dialog and on the close button", async () => {
    stubSwitch();
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    await click(trigger());
    await click(container.querySelector<HTMLElement>(".fa-branch__overlay"));
    expect(dialog()).toBeNull();

    await click(trigger());
    await click(closeButton());
    expect(dialog()).toBeNull();
  });

  it("keeps Tab inside the dialog, wrapping from the last item to the first", async () => {
    stubSwitch();
    await show(<BranchSwitchA repoId={repoId} currentBranch="main" />);
    await click(trigger());
    const last = rows()[rows().length - 1];
    last.focus();
    await press("Tab", last);

    expect(document.activeElement).toBe(closeButton());
  });
});
