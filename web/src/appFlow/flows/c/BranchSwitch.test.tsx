// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoBranches } from "../../../types";
import type { BranchSwitch } from "../../hooks/useBranchSwitch";
import { useBranchSwitch } from "../../hooks/useBranchSwitch";
import { BranchSwitchC } from "./BranchSwitch";

vi.mock("../../hooks/useBranchSwitch", () => ({ useBranchSwitch: vi.fn() }));

const repoBranches = (analyzed: RepoBranches["analyzed"]) => ({
  status: "ready" as const,
  data: {
    repo: "Flagsmith/flagsmith",
    full_name: "Flagsmith/flagsmith",
    default_branch: "main",
    current_branch: "main",
    branches: ["main", "feat/snowflake-dialect", "release/2.296"],
    analyzed,
  },
});

const mainOnly = repoBranches([{ branch: "main", id: "Flagsmith__flagsmith", status: "ready" }]);
const withFeature = repoBranches([
  { branch: "main", id: "Flagsmith__flagsmith", status: "ready" },
  { branch: "feat/snowflake-dialect", id: "Flagsmith__flagsmith@feat~snowflake-dialect", status: "ready" },
]);

function commitsOf(count: number) {
  return {
    status: "ready" as const,
    data: {
      branch: "feat/snowflake-dialect",
      limit: 20,
      commits: Array.from({ length: count }, (_, index) => ({
        sha: `${index}abcdef0123456789`,
        message: `Commit ${index}`,
        author: "Zaimwa9",
        date: "2026-11-24T10:00:00Z",
        url: "https://github.com/Flagsmith/flagsmith/commit/x",
      })),
    },
  };
}

let root: Root;
let container: HTMLDivElement;
let select: BranchSwitch["select"];
let analyze: BranchSwitch["analyze"];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  select = vi.fn();
  analyze = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function state(overrides: Partial<BranchSwitch> = {}): BranchSwitch {
  return {
    info: mainOnly,
    selected: null,
    select,
    commits: { status: "loading" },
    analyze,
    progress: null,
    error: null,
    githubRepoId: null,
    ...overrides,
  };
}

async function show(value: BranchSwitch) {
  vi.mocked(useBranchSwitch).mockReturnValue(value);
  await act(async () => root.render(<BranchSwitchC repoId="Flagsmith__flagsmith" currentBranch="main" />));
}

function trigger() {
  return container.querySelector<HTMLButtonElement>(".fc-branch__trigger");
}

function dialog() {
  return container.querySelector<HTMLElement>("[role=dialog]");
}

function button(text: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}

describe("branch switch (flow C)", () => {
  it("shows the current branch on the trigger, with the list closed", async () => {
    await show(state());
    expect(trigger()?.textContent).toContain("main");
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    expect(useBranchSwitch).toHaveBeenLastCalledWith("Flagsmith__flagsmith", false);
  });

  it("opens the branch list with the current and analyzed branches marked", async () => {
    await show(state({ info: withFeature }));
    await click(trigger());
    expect(useBranchSwitch).toHaveBeenLastCalledWith("Flagsmith__flagsmith", true);
    expect(dialog()?.getAttribute("aria-labelledby")).toBeTruthy();
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".fc-branch__row")];
    expect(rows.map((row) => row.querySelector(".fc-branch__row-name")?.textContent?.trim())).toEqual([
      "main · default", "feat/snowflake-dialect", "release/2.296",
    ]);
    expect(rows[0].getAttribute("aria-current")).toBe("true");
    expect(rows[0].getAttribute("aria-pressed")).toBe("true");
    expect(rows[1].textContent).toContain("Analyzed");
    expect(rows[2].textContent).toContain("Not analyzed");
  });

  it("picks a branch that is not analyzed and analyzes its latest commits", async () => {
    await show(state({ info: withFeature }));
    await click(trigger());
    await click(button("release/2.296"));
    expect(select).toHaveBeenCalledWith("release/2.296");
  });

  it("shows the latest commits as a rail and starts the analysis", async () => {
    await show(state({ info: mainOnly, selected: "feat/snowflake-dialect", commits: commitsOf(3) }));
    await click(trigger());
    expect(container.querySelector(".fc-branch__detail-title")?.textContent).toBe(
      "Latest 3 commits on feat/snowflake-dialect",
    );
    expect(container.querySelectorAll(".fc-branch__rail li")).toHaveLength(3);
    expect(container.querySelectorAll(".fc-branch__dot.is-filled")).toHaveLength(0);
    await click(button("Analyze 3 commits"));
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("shows the progress of the analysis and fills the rail as it goes", async () => {
    await show(state({
      info: mainOnly,
      selected: "feat/snowflake-dialect",
      commits: commitsOf(20),
      progress: { text: "Analyzing commit 12 of 20", current: 12, total: 20 },
    }));
    await click(trigger());
    expect(container.querySelector("[role=status]")?.textContent).toBe("Analyzing commit 12 of 20");
    expect(container.querySelectorAll(".fc-branch__dot.is-filled")).toHaveLength(12);
    expect(button("Analyze 20 commits")).toBeUndefined();
  });

  it("shows an analysis error with a retry", async () => {
    await show(state({
      info: mainOnly,
      selected: "feat/snowflake-dialect",
      commits: commitsOf(2),
      error: "The import failed",
    }));
    await click(trigger());
    expect(container.querySelector("[role=alert]")?.textContent).toContain("The import failed");
    await click(button("Try again"));
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("opens an analyzed branch straight away once its commits are known", async () => {
    await show(state({ info: withFeature, selected: "feat/snowflake-dialect", commits: commitsOf(3) }));
    await click(trigger());
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Opening feat/snowflake-dialect…");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    await show(state());
    await click(trigger());
    expect(dialog()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes with the close button", async () => {
    await show(state());
    await click(trigger());
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Close branch list"]'));
    expect(dialog()).toBeNull();
  });

  it("closes when the press is outside the switch", async () => {
    await show(state());
    await click(trigger());
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it("closes without selecting when the current branch is picked", async () => {
    await show(state({ info: withFeature }));
    await click(trigger());
    await click(button("main · default"));
    expect(select).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
