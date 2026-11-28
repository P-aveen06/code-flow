// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubCommit, GitHubRepoChoice, ImportStatus, Me } from "../../../types";
import { useMe } from "../../hooks/useMe";
import { useRepoDetails } from "../../hooks/useRepoDetails";
import { RepoDetailsB } from "./RepoDetails";

vi.mock("../../hooks/useRepoDetails", () => ({ useRepoDetails: vi.fn() }));
vi.mock("../../hooks/useMe", () => ({ useMe: vi.fn() }));

type Details = ReturnType<typeof useRepoDetails>;

const repo: GitHubRepoChoice = { id: 1001, full_name: "Flagsmith/flagsmith", private: false, default_branch: "main", installation_id: 1 };
const commits: GitHubCommit[] = [
  { sha: "add5187aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "feat: add a client", author: "Zaimwa9", date: "2026-11-27T10:00:00Z", url: "https://github.com/Flagsmith/flagsmith/commit/add5187" },
  { sha: "10483a0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", message: "fix: compute results", author: "Zaimwa9", date: "2026-11-27T09:00:00Z", url: "https://github.com/Flagsmith/flagsmith/commit/10483a0" },
];
const account: Me = { configured: true, signed_in: true, login: "demo-user", avatar_url: "", install_url: "" };

function details(overrides: Partial<Details> = {}): Details {
  return {
    branches: { status: "ready", data: { repo, branches: ["main", "feat/snowflake-dialect"] } },
    branch: "main",
    setBranch: vi.fn(),
    commitCount: { count: 20, ready: true },
    commits: { status: "ready", data: { branch: "main", limit: 20, commits } },
    subdir: "",
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
  } as Details;
}

function status(overrides: Partial<ImportStatus>): ImportStatus {
  return {
    id: "Flagsmith__flagsmith", name: "Flagsmith/flagsmith", status: "analyzing", message: "Analyzing",
    current: 12, total: 20, warning: null, error: null, new_commits: null, seconds: 7.4, ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.history.replaceState(null, "", "/github/1001");
  vi.mocked(useMe).mockReturnValue({ me: { status: "ready", data: account }, refresh: vi.fn(), signOut: vi.fn() });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function show(state: Details) {
  vi.mocked(useRepoDetails).mockReturnValue(state);
  await act(async () => root.render(<RepoDetailsB repoId={1001} search="" />));
}

function button(label: string) {
  return [...container.querySelectorAll("button, a")].find((element) => element.textContent?.includes(label));
}

async function click(element: Element | undefined) {
  await act(async () => element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

describe("flow B repo details", () => {
  it("shows the branches, with the chosen one pressed, and picking another calls setBranch", async () => {
    const state = details();
    await show(state);
    expect(container.querySelector("h1")?.textContent).toBe("Flagsmith/flagsmith");
    expect(button("feat/snowflake-dialect")?.getAttribute("aria-pressed")).toBe("false");
    expect(button("main")?.getAttribute("aria-pressed")).toBe("true");

    await click(button("feat/snowflake-dialect"));
    expect(state.setBranch).toHaveBeenCalledWith("feat/snowflake-dialect");
  });

  it("lists the latest commits with links to GitHub, and Analyze starts the analysis", async () => {
    const state = details();
    await show(state);
    expect(container.querySelector("a[href='https://github.com/Flagsmith/flagsmith/commit/add5187']")?.textContent).toBe("add5187");
    expect(container.textContent).toContain("fix: compute results");

    const form = container.querySelector("form");
    await act(async () => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(state.analyze).toHaveBeenCalledTimes(1);
  });

  it("passes the subfolder typed by the visitor to setSubdir", async () => {
    const state = details();
    await show(state);
    const input = container.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    await act(async () => {
      // React tracks the value, so the change goes through the native setter.
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "api/");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(state.setSubdir).toHaveBeenCalledWith("api/");
  });

  it("shows the steps and the commit count while the analysis runs, without an analyze button", async () => {
    await show(details({
      job: { id: "Flagsmith__flagsmith", status: "analyzing", body: { github_repo_id: 1001, installation_id: 1, branch: "main", subdir: "", max_commits: 20 } },
      update: status({}),
      busy: true,
    }));
    expect(container.querySelector("[role='status'][aria-label='Import progress']")?.textContent).toContain("Analyzing commit 12 of 20");
    expect(container.textContent).toContain("7.4 s");
    expect(container.querySelector("progress")?.getAttribute("value")).toBe("12");
    expect(button("Analyze 2 commits")).toBeUndefined();
  });

  it("links to the flow view once the analysis is ready", async () => {
    await show(details({
      job: { id: "Flagsmith__flagsmith", status: "analyzing", body: { github_repo_id: 1001, installation_id: 1, branch: "main", subdir: "", max_commits: 20 } },
      update: status({ status: "ready", message: "Ready", current: 20, total: 20 }),
    }));
    expect(button("Open")?.getAttribute("href")).toBe("/repo/Flagsmith__flagsmith");
  });

  it("shows a failed analysis with its message, and Try again calls retry", async () => {
    const state = details({
      job: { id: "Flagsmith__flagsmith", status: "analyzing", body: { github_repo_id: 1001, installation_id: 1, branch: "main", subdir: "", max_commits: 20 } },
      update: status({ status: "error", error: "Cloning failed: repository not found." }),
    });
    await show(state);
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Cloning failed: repository not found.");
    await click(button("Try again"));
    expect(state.retry).toHaveBeenCalledTimes(1);
  });

  it("asks for the branches and commits again when they fail to load", async () => {
    const hook = vi.mocked(useRepoDetails);
    await show(details({ commits: { status: "error", message: "Commits could not be read." } }));
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Commits could not be read.");

    const calls = hook.mock.calls.length;
    await click(button("Try again"));
    expect(hook.mock.calls.length).toBeGreaterThan(calls);
  });
});
