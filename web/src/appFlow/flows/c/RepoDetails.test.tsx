// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubBranches, GitHubCommit, GitHubRepoChoice, ImportStatus } from "../../../types";
import type { useRepoDetails } from "../../hooks/useRepoDetails";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState } from "../../types";
import { RepoDetailsC } from "./RepoDetails";

type Details = ReturnType<typeof useRepoDetails>;
type Job = NonNullable<Details["job"]>;

const mocks = vi.hoisted(() => ({
  details: vi.fn(),
  signOut: vi.fn(),
  me: {
    status: "ready",
    data: {
      configured: true,
      signed_in: true,
      login: "demo-user",
      avatar_url: "",
      install_url: "https://github.example/apps/code-flow/installations/new",
    },
  },
}));

vi.mock("../../hooks/useRepoDetails", () => ({ useRepoDetails: () => mocks.details() }));
vi.mock("../../hooks/useMe", () => ({
  useMe: () => ({ me: mocks.me, refresh: () => {}, signOut: mocks.signOut }),
}));

const REPO: GitHubRepoChoice = {
  id: 1001, full_name: "Flagsmith/flagsmith", private: false, default_branch: "main", installation_id: 9,
};
const BRANCHES: GitHubBranches = { repo: REPO, branches: ["main", "feat/snowflake-dialect"] };
const JOB: Job = {
  id: "p1", status: "queued", body: { github_repo_id: 1001, installation_id: 9, subdir: "api/", max_commits: 20 },
};

function commitList(count: number): GitHubCommit[] {
  return Array.from({ length: count }, (_, index) => ({
    sha: `sha${index}`.padEnd(40, "0"),
    message: `Commit ${index}`,
    author: "Zaimwa9",
    date: "2026-11-27T10:00:00Z",
    url: `https://github.example/commit/${index}`,
  }));
}

function importStatus(overrides: Partial<ImportStatus>): ImportStatus {
  return {
    id: "p1", status: "analyzing", name: "Flagsmith__flagsmith", message: "", current: null, total: null,
    warning: null, error: null, new_commits: null, seconds: 0, ...overrides,
  };
}

// The hook's state for the page: the repo's branches and three commits, unless a test changes them.
function details(overrides: Partial<Details> = {}): Details {
  return {
    branches: { status: "ready", data: BRANCHES },
    branch: "main",
    setBranch: vi.fn(),
    commitCount: { count: 20, ready: true },
    commits: { status: "ready", data: { branch: "main", limit: 20, commits: commitList(3) } },
    subdir: "api/",
    setSubdir: vi.fn(),
    formError: null,
    analyze: vi.fn(),
    submitting: false,
    busy: false,
    job: null,
    update: undefined,
    pollError: null,
    retry: vi.fn(),
    ...overrides,
  };
}

const APP_STATE: AppFlowState = {
  ready: true,
  reviewerId: "demo",
  flow: "c",
  pieces: { ...TODAY_PIECES, repo_details_layout: "c" },
  exposed: false,
  preview: false,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.history.replaceState(null, "", "/github/1001");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(state: Details) {
  mocks.details.mockReturnValue(state);
  await act(async () => root.render(
    <AppFlowTestProvider value={APP_STATE}>
      <RepoDetailsC repoId={1001} search="" />
    </AppFlowTestProvider>,
  ));
}

// The link or button with this text.
function control(text: string): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>("a, button"))
    .find((element) => element.textContent?.trim() === text);
  if (!found) throw new Error(`No control reads "${text}"`);
  return found;
}

describe("repo details page", () => {
  it("says the repository is loading", async () => {
    await show(details({ branches: { status: "loading" } }));
    expect(container.querySelector("[role='status']")?.textContent).toBe("Loading the repository…");
  });

  it("marks the chosen branch, and switches to another", async () => {
    const state = details({ branch: "main" });
    await show(state);
    const pills = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='group'] button"));
    expect(pills.map((pill) => pill.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    await act(async () => pills[1].click());
    expect(state.setBranch).toHaveBeenCalledWith("feat/snowflake-dialect");
  });

  it("lists the latest commits with links to GitHub, and the commit count", async () => {
    await show(details());
    expect(container.querySelector("h2")?.textContent).toBe("Latest 3 commits on main");
    expect(container.querySelector(".fc-repo-details__sha")?.getAttribute("href")).toBe("https://github.example/commit/0");
    expect(container.querySelector(".fc-repo-details__hint")?.textContent).toContain("Up to 20 commits");
    expect(container.textContent).toContain("This branch has 3.");
  });

  it("analyzes the branch from the form", async () => {
    const state = details();
    await show(state);
    await act(async () => container.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ));
    expect(state.analyze).toHaveBeenCalledOnce();
    expect(control("Analyze 3 commits")).toBeTruthy();
  });

  it("fills in the commit rail and shows the progress while a branch is analysed", async () => {
    await show(details({
      commits: { status: "ready", data: { branch: "main", limit: 20, commits: commitList(20) } },
      job: JOB,
      busy: true,
      update: importStatus({ status: "analyzing", current: 12, total: 20, seconds: 7.4 }),
    }));
    expect(container.querySelectorAll(".fc-repo-details__dot--filled")).toHaveLength(12);
    expect(container.querySelector("[role='status'] h3")?.textContent).toBe("Analyzing commit 12 of 20");
    expect(container.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("60");
    expect(container.querySelector(".fc-repo-details__pill")?.textContent).toBe("Analyzing commit 12 of 20 · 7.4 s");
    expect((control("Analyzing…") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers to try again when the progress check fails", async () => {
    const state = details({
      job: JOB,
      pollError: "The connection dropped.",
      update: importStatus({ status: "analyzing", current: 4, total: 20, seconds: 2 }),
    });
    await show(state);
    expect(container.querySelector("[role='alert']")?.textContent).toBe("The connection dropped.");
    await act(async () => control("Try again").click());
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("offers the flow view once the import is ready", async () => {
    await show(details({ job: JOB, update: importStatus({ status: "ready", current: 20, total: 20, seconds: 9 }) }));
    expect(container.querySelector("h3")?.textContent).toBe("Ready");
    expect(control("Open").getAttribute("href")).toBe("/repo/p1");
  });

  it("says when the branch has no commits, and does not offer to analyze it", async () => {
    await show(details({ commits: { status: "ready", data: { branch: "main", limit: 20, commits: [] } } }));
    expect(container.textContent).toContain("This branch has no commits.");
    expect((control("Analyze 0 commits") as HTMLButtonElement).disabled).toBe(true);
  });
});
