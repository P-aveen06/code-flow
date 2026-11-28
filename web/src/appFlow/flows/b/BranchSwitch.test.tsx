// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubCommitList, RepoBranches } from "../../../types";
import { useBranchSwitch } from "../../hooks/useBranchSwitch";
import type { BranchSwitch } from "../../hooks/useBranchSwitch";
import { BranchSwitchB } from "./BranchSwitch";

vi.mock("../../hooks/useBranchSwitch", () => ({ useBranchSwitch: vi.fn() }));

const branches: RepoBranches = {
  repo: "Flagsmith__flagsmith",
  full_name: "Flagsmith/flagsmith",
  default_branch: "main",
  current_branch: "main",
  branches: ["main", "feat/snowflake-dialect"],
  analyzed: [{ branch: "main", id: "Flagsmith__flagsmith", status: "ready" }],
};

const snowflakeCommits: GitHubCommitList = {
  branch: "feat/snowflake-dialect",
  limit: 50,
  commits: [{
    sha: "a".repeat(40), message: "Add Snowflake dialect", author: "octo", date: "2026-11-27T10:00:00Z", url: "",
  }],
};

const mainCommits: GitHubCommitList = { ...snowflakeCommits, branch: "main", commits: [{ ...snowflakeCommits.commits[0], message: "Release 2.1" }] };

// The switch's data with nothing picked yet. Tests override the parts they need.
function switcher(overrides: Partial<BranchSwitch> = {}): BranchSwitch {
  return {
    info: { status: "ready", data: branches },
    selected: null,
    select: vi.fn(),
    commits: { status: "loading" },
    analyze: vi.fn(),
    progress: null,
    error: null,
    githubRepoId: null,
    ...overrides,
  };
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
});

async function render(state: BranchSwitch) {
  vi.mocked(useBranchSwitch).mockReturnValue(state);
  await act(async () => root.render(<BranchSwitchB repoId="Flagsmith__flagsmith" currentBranch="main" />));
}

function trigger() {
  const found = container.querySelector<HTMLButtonElement>(".fb-branch__trigger");
  if (!found) throw new Error("No branch trigger");
  return found;
}

function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

function row(name: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".fb-branch__row")]
    .find((item) => item.querySelector("code")?.textContent === name);
  if (!found) throw new Error(`No branch row "${name}"`);
  return found;
}

function dialog() {
  return container.querySelector<HTMLElement>('[role="dialog"]');
}

async function open() {
  await act(async () => trigger().click());
}

describe("closed branch switch", () => {
  it("shows only the trigger with the current branch", async () => {
    await render(switcher());
    expect(trigger().textContent).toContain("main");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    expect(useBranchSwitch).toHaveBeenLastCalledWith("Flagsmith__flagsmith", false);
  });

  it("shows an analysis that runs while the switch is closed", async () => {
    await render(switcher({ progress: { text: "Analysing 5 of 20 commits", current: 5, total: 20 } }));
    expect(container.querySelector(".fb-branch__busy")?.textContent).toBe("Analysing 5 of 20 commits");
  });
});

describe("open branch switch", () => {
  it("lists the branches, marks the current one and the analysed ones", async () => {
    await render(switcher());
    await open();
    expect(dialog()?.getAttribute("aria-label")).toBe("Switch branch");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(row("main").getAttribute("aria-current")).toBe("true");
    expect(row("main").textContent).toContain("Analyzed");
    expect(row("main").textContent).toContain("default");
    expect(row("feat/snowflake-dialect").getAttribute("aria-current")).toBeNull();
    expect(row("feat/snowflake-dialect").textContent).toContain("Not analyzed");
  });

  it("shows the loading and the error of the branch list", async () => {
    await render(switcher({ info: { status: "loading" } }));
    await open();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading branches…");

    await render(switcher({ info: { status: "error", message: "GitHub is unreachable." } }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("GitHub is unreachable.");
  });

  it("picks a branch and analyses it with its latest commits", async () => {
    const select = vi.fn();
    const analyze = vi.fn();
    await render(switcher({ select, analyze }));
    await open();
    await act(async () => row("feat/snowflake-dialect").click());
    expect(select).toHaveBeenCalledWith("feat/snowflake-dialect");

    // The hook reports the pick with its commits; the preview shows them and the Analyze action.
    await render(switcher({
      select, analyze, selected: "feat/snowflake-dialect", commits: { status: "ready", data: snowflakeCommits },
    }));
    expect(container.querySelector(".fb-branch__title h3")?.textContent).toBe("Latest 50 commits on");
    expect(container.querySelector(".fb-branch__commits")?.textContent).toContain("Add Snowflake dialect");
    expect(container.querySelector(".fb-branch__hint")?.textContent).toContain("branch_commit_count");
    await act(async () => button("Analyze 50 commits").click());
    expect(analyze).toHaveBeenCalled();
  });

  it("offers Open for a branch that is already analysed", async () => {
    const analyze = vi.fn();
    await render(switcher({ analyze, selected: "main", commits: { status: "ready", data: mainCommits } }));
    await open();
    await act(async () => button("Open").click());
    expect(analyze).toHaveBeenCalled();
  });

  it("shows the analysis progress in place of the action", async () => {
    await render(switcher({
      selected: "feat/snowflake-dialect",
      commits: { status: "ready", data: snowflakeCommits },
      progress: { text: "Analysing 5 of 20 commits", current: 5, total: 20 },
    }));
    await open();
    expect(container.textContent).toContain("Analysing 5 of 20 commits");
    expect(container.querySelector('progress[aria-label="Analysis progress"]')?.getAttribute("value")).toBe("5");
    expect(container.textContent).not.toContain("Analyze 50 commits");
  });

  it("shows an error with a retry that analyses again", async () => {
    const analyze = vi.fn();
    await render(switcher({
      analyze,
      selected: "feat/snowflake-dialect",
      commits: { status: "ready", data: snowflakeCommits },
      error: "The import could not start.",
    }));
    await open();
    expect(container.querySelector('.fb-branch__error[role="alert"]')?.textContent).toContain("The import could not start.");
    await act(async () => button("Try again").click());
    expect(analyze).toHaveBeenCalled();
  });
});

describe("closing the branch switch", () => {
  it("closes on Escape and returns focus to the trigger", async () => {
    await render(switcher());
    await open();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(dialog()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a press outside and leaves focus where it is", async () => {
    await render(switcher());
    await open();
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(dialog()).toBeNull();
  });

  it("closes with its close button and returns focus to the trigger", async () => {
    await render(switcher());
    await open();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close branches"]')?.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
