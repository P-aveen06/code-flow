// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitHubRepos, fetchMe, fetchRepoBranchCommits, fetchRepoBranches, importRepoBranch,
} from "../../api";
import { useBranchCommitCount } from "../../flags";
import { pollRepoStatus } from "../../pollRepoStatus";
import { navigate } from "../../router";
import type {
  GitHubCommitList, GitHubRepoChoice, ImportResponse, ImportStatus, Me, RepoBranches,
} from "../../types";
import { markBranchSwitchOpened } from "../journey";
import { type BranchSwitch, useBranchSwitch } from "./useBranchSwitch";

vi.mock("../../api", () => ({
  fetchGitHubRepos: vi.fn(),
  fetchMe: vi.fn(),
  fetchRepoBranchCommits: vi.fn(),
  fetchRepoBranches: vi.fn(),
  importRepoBranch: vi.fn(),
}));
vi.mock("../../flags", () => ({ useBranchCommitCount: vi.fn() }));
vi.mock("../../pollRepoStatus", () => ({ pollRepoStatus: vi.fn() }));
vi.mock("../journey", () => ({ markBranchSwitchOpened: vi.fn() }));
vi.mock("../../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../router")>()),
  navigate: vi.fn(),
}));

const branches: RepoBranches = {
  repo: "Demo__shop",
  full_name: "Demo/shop",
  default_branch: "main",
  current_branch: "main",
  branches: ["main", "feature/cart"],
  analyzed: [{ branch: "main", id: "Demo__shop", status: "ready" }],
};
const cart = "Demo__shop@feature~cart";
const signedOut: Me = { configured: true, signed_in: false };
const signedIn: Me = {
  configured: true, signed_in: true, login: "octo", avatar_url: "", install_url: "https://github.test/install",
};

function commitList(branch: string, limit: number): GitHubCommitList {
  return {
    branch,
    limit,
    commits: [{ sha: "a".repeat(40), message: `${branch} tip`, author: "octo", date: "2026-11-27T10:00:00Z", url: "" }],
  };
}

function importStatus(update: Partial<ImportStatus>): ImportStatus {
  return {
    id: cart, name: "Demo/shop@feature/cart", status: "analyzing", message: "Analyzing repository",
    current: null, total: null, warning: null, error: null, new_commits: null, seconds: 1, ...update,
  };
}

let root: Root;
let container: HTMLDivElement;
let latest: BranchSwitch;

function Probe({ repoId, open }: { repoId: string; open: boolean }) {
  latest = useBranchSwitch(repoId, open);
  return null;
}

async function mount(open: boolean, repoId = "Demo__shop") {
  await act(async () => root.render(<Probe repoId={repoId} open={open} />));
}

// Lets pending requests and the state updates they cause settle.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Opens the switch on the default repo and picks a branch.
async function openAndPick(branch: string) {
  await mount(true);
  await settle();
  await act(async () => latest.select(branch));
  await settle();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(useBranchCommitCount).mockReturnValue({ count: 20, ready: true });
  vi.mocked(fetchRepoBranches).mockResolvedValue(branches);
  vi.mocked(fetchRepoBranchCommits).mockImplementation(async (_repo, branch, limit) => commitList(branch, limit));
  vi.mocked(fetchMe).mockResolvedValue(signedOut);
  vi.mocked(fetchGitHubRepos).mockResolvedValue([]);
  // A poll that never finishes, unless a test says otherwise.
  vi.mocked(pollRepoStatus).mockReturnValue(new Promise(() => {}));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useBranchSwitch", () => {
  it("loads the branches when the switch first opens, and keeps them after it closes", async () => {
    await mount(false);
    expect(fetchRepoBranches).not.toHaveBeenCalled();
    expect(markBranchSwitchOpened).not.toHaveBeenCalled();
    expect(latest.info).toEqual({ status: "loading" });

    await mount(true);
    await settle();
    expect(fetchRepoBranches).toHaveBeenCalledWith("Demo__shop", expect.any(AbortSignal));
    expect(latest.info).toEqual({ status: "ready", data: branches });
    expect(markBranchSwitchOpened).toHaveBeenCalledTimes(1);

    await mount(false);
    await mount(true);
    await settle();
    expect(fetchRepoBranches).toHaveBeenCalledTimes(1);
    expect(markBranchSwitchOpened).toHaveBeenCalledTimes(1);
    expect(latest.info).toEqual({ status: "ready", data: branches });
  });

  it("starts with no branch selected, then loads the latest commits of the one picked", async () => {
    await mount(true);
    await settle();
    expect(latest.selected).toBeNull();
    expect(latest.commits).toEqual({ status: "loading" });
    expect(fetchRepoBranchCommits).not.toHaveBeenCalled();

    await openAndPick("feature/cart");
    expect(latest.selected).toBe("feature/cart");
    expect(fetchRepoBranchCommits).toHaveBeenCalledWith(
      "Demo__shop", "feature/cart", 20, expect.any(AbortSignal),
    );
    expect(latest.commits).toEqual({ status: "ready", data: commitList("feature/cart", 20) });
  });

  it("forgets the selection when the switch is for another repo", async () => {
    await openAndPick("feature/cart");
    await mount(true, "Demo__other");
    await settle();
    expect(latest.selected).toBeNull();
    expect(fetchRepoBranches).toHaveBeenLastCalledWith("Demo__other", expect.any(AbortSignal));
  });

  it("opens a branch that is already ready without starting another analysis", async () => {
    vi.mocked(fetchRepoBranches).mockResolvedValue({
      ...branches,
      analyzed: [{ branch: "feature/cart", id: cart, status: "ready" }],
    });
    await openAndPick("feature/cart");

    await act(async () => latest.analyze());
    expect(importRepoBranch).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/repo/Demo__shop%40feature~cart");
  });

  it("analyzes an unanalyzed branch with the commit count, reports progress, then opens it", async () => {
    let accept!: (response: ImportResponse) => void;
    vi.mocked(importRepoBranch).mockReturnValue(new Promise((resolve) => { accept = resolve; }));
    let report!: (update: ImportStatus) => void;
    let finish!: (update: ImportStatus) => void;
    vi.mocked(pollRepoStatus).mockImplementation((_id, _signal, onUpdate) => {
      report = onUpdate;
      return new Promise((resolve) => { finish = resolve; });
    });
    await openAndPick("feature/cart");

    await act(async () => latest.analyze());
    expect(importRepoBranch).toHaveBeenCalledWith(
      "Demo__shop", { branch: "feature/cart", max_commits: 20 }, expect.any(AbortSignal),
    );
    expect(latest.progress).toEqual({ text: "Starting analysis…", current: 0, total: 0 });

    await act(async () => accept({ id: cart, status: "queued" }));
    expect(pollRepoStatus).toHaveBeenCalledWith(cart, expect.any(AbortSignal), expect.any(Function));
    expect(latest.progress).toEqual({ text: "Queued", current: 0, total: 0 });

    await act(async () => report(importStatus({ status: "analyzing", current: 2, total: 5 })));
    expect(latest.progress).toEqual({ text: "Analyzing commit 2 of 5", current: 2, total: 5 });
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => finish(importStatus({ status: "ready", message: "Ready" })));
    expect(navigate).toHaveBeenCalledWith("/repo/Demo__shop%40feature~cart");
    expect(latest.progress).toBeNull();
  });

  it("shows the server's refusal to start an analysis, and clears it when another branch is picked", async () => {
    vi.mocked(importRepoBranch).mockRejectedValue(new Error("Pick a branch from the list"));
    await openAndPick("feature/cart");

    await act(async () => latest.analyze());
    expect(latest.error).toBe("Pick a branch from the list");
    expect(latest.progress).toBeNull();
    expect(pollRepoStatus).not.toHaveBeenCalled();

    await act(async () => latest.select("main"));
    expect(latest.error).toBeNull();
  });

  it("reports an analysis that the server could not finish", async () => {
    vi.mocked(importRepoBranch).mockResolvedValue({ id: cart, status: "queued" });
    vi.mocked(pollRepoStatus).mockResolvedValue(importStatus({
      status: "error", message: "Could not analyze repository",
      error: "Branch feature/cart not found, or code-flow has no access to it",
    }));
    await openAndPick("feature/cart");

    await act(async () => latest.analyze());
    await settle();
    expect(latest.error).toBe("Branch feature/cart not found, or code-flow has no access to it");
    expect(latest.progress).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("finds the GitHub repo of a signed-in visitor, ignoring case", async () => {
    vi.mocked(fetchMe).mockResolvedValue(signedIn);
    const choices: GitHubRepoChoice[] = [
      { id: 8, full_name: "demo/other", private: false, default_branch: "main", installation_id: 9 },
      { id: 7, full_name: "demo/SHOP", private: false, default_branch: "main", installation_id: 9 },
    ];
    vi.mocked(fetchGitHubRepos).mockResolvedValue(choices);
    await mount(true);
    await settle();
    expect(latest.githubRepoId).toBe(7);
  });

  it("has no GitHub repo for a signed-out visitor, or when the GitHub lookup fails", async () => {
    await mount(true);
    await settle();
    expect(latest.githubRepoId).toBeNull();
    expect(fetchGitHubRepos).not.toHaveBeenCalled();

    vi.mocked(fetchMe).mockResolvedValue(signedIn);
    vi.mocked(fetchGitHubRepos).mockRejectedValue(new Error("Server returned HTTP 502"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(true);
    await settle();
    expect(latest.info.status).toBe("ready");
    expect(latest.githubRepoId).toBeNull();
  });

  it("aborts the requests still waiting when the page unmounts", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(fetchRepoBranches).mockImplementation((_repo, requestSignal) => {
      signal = requestSignal;
      return new Promise<RepoBranches>(() => {});
    });
    await mount(true);
    expect(signal?.aborted).toBe(false);

    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    root = createRoot(container);
  });
});
