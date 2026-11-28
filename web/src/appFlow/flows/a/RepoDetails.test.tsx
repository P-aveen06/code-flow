// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportStatus } from "../../../types";
import { useRepoDetails, type PickedImportJob } from "../../hooks/useRepoDetails";
import { RepoDetailsA } from "./RepoDetails";

vi.mock("../../hooks/useRepoDetails", () => ({ useRepoDetails: vi.fn() }));

type Details = ReturnType<typeof useRepoDetails>;

const repo = { id: 1001, full_name: "Flagsmith/flagsmith", private: false, default_branch: "main", installation_id: 1 };
const commits = Array.from({ length: 6 }, (_, index) => ({
  sha: `${index}abc1234def`,
  message: `commit ${index}`,
  author: "Zaimwa9",
  date: "2026-11-27T10:00:00Z",
  url: `https://github.com/Flagsmith/flagsmith/commit/${index}abc1234def`,
}));
const job: PickedImportJob = {
  id: "Flagsmith__flagsmith",
  status: "queued",
  body: { github_repo_id: 1001, installation_id: 1, branch: "main", subdir: "api", max_commits: 20 },
};
const actions = { setBranch: vi.fn(), setSubdir: vi.fn(), analyze: vi.fn(), retry: vi.fn() };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
  setDetails({});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// The loaded repository with its branches and the latest commits of main, unless overridden.
function setDetails(overrides: Partial<Details>) {
  const details: Details = {
    branches: { status: "ready", data: { repo, branches: ["main", "feat/snowflake-dialect"] } },
    branch: "main",
    setBranch: actions.setBranch,
    commitCount: { count: 20, ready: true },
    commits: { status: "ready", data: { branch: "main", limit: 20, commits } },
    subdir: "",
    setSubdir: actions.setSubdir,
    formError: null,
    analyze: actions.analyze,
    submitting: false,
    busy: false,
    job: null,
    update: undefined,
    pollError: null,
    retry: actions.retry,
    ...overrides,
  };
  vi.mocked(useRepoDetails).mockReturnValue(details);
}

function status(overrides: Partial<ImportStatus>): ImportStatus {
  return {
    id: "Flagsmith__flagsmith",
    status: "analyzing",
    name: "Flagsmith/flagsmith",
    message: "",
    current: null,
    total: null,
    warning: null,
    error: null,
    new_commits: null,
    seconds: 0,
    ...overrides,
  };
}

async function show() {
  await act(async () => root.render(<RepoDetailsA repoId={1001} search="" />));
}

function findByText<T extends HTMLElement>(selector: string, text: string): T | undefined {
  return [...container.querySelectorAll<T>(selector)].find((element) => element.textContent?.includes(text));
}

describe("repo details page", () => {
  it("lists the branches, marks the default and chooses one", async () => {
    await show();

    const radios = [...container.querySelectorAll<HTMLInputElement>("input[type='radio']")];
    expect(radios.map((radio) => radio.value)).toEqual(["main", "feat/snowflake-dialect"]);
    expect(radios[0].checked).toBe(true);
    expect(container.querySelector(".fa-branch--selected")?.textContent).toContain("main");
    expect(findByText("label", "main")?.textContent).toContain("Default");

    await act(async () => radios[1].click());
    expect(actions.setBranch).toHaveBeenCalledWith("feat/snowflake-dialect");
  });

  it("lists the latest commits, five at first, with the count and a show-all disclosure", async () => {
    await show();

    expect(container.textContent).toContain("Latest 6 commits on main");
    expect(container.textContent).toContain("This branch has 6.");
    // The first list holds the five newest; the rest sit under the closed disclosure.
    expect(container.querySelector(".fa-commits")?.querySelectorAll("li")).toHaveLength(5);
    expect(findByText("summary", "Show all 6")).toBeDefined();
    expect(container.querySelector("a[href='https://github.com/Flagsmith/flagsmith/commit/0abc1234def']")?.textContent)
      .toBe("0abc123");
  });

  it("keeps the subfolder under Advanced and reports its edits", async () => {
    await show();

    expect(findByText("summary", "Advanced")).toBeDefined();
    const input = container.querySelector<HTMLInputElement>("#repo-subdir");
    expect(input?.value).toBe("");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "api/");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(actions.setSubdir).toHaveBeenCalledWith("api/");
  });

  it("analyzes the chosen branch from the bar, which names the commit count", async () => {
    await show();

    const analyze = findByText<HTMLButtonElement>("button", "Analyze 6 commits");
    expect(analyze?.disabled).toBe(false);
    await act(async () => analyze?.click());
    expect(actions.analyze).toHaveBeenCalledOnce();
  });

  it("shows the form error above the Analyze button", async () => {
    setDetails({ formError: "Enter a folder inside the repository without any .. segments, such as api/." });
    await show();

    expect(container.querySelector(".fa-repo-details__bar [role='alert']")?.textContent)
      .toContain("without any .. segments");
  });

  it("shows loading and error states for the repository", async () => {
    setDetails({ branches: { status: "loading" } });
    await show();
    expect(container.querySelector("[role='status']")?.textContent).toBe("Loading the repository…");

    setDetails({ branches: { status: "error", message: "Not found." } });
    await show();
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Not found.");
  });

  it("shows the analysis progress in place of the branch picker and bar", async () => {
    setDetails({
      job,
      update: status({ status: "analyzing", message: "Analyzing 12 of 20", current: 12, total: 20, seconds: 7.4 }),
    });
    await show();

    expect(container.querySelector("h1")?.textContent).toBe("Import progress");
    expect(container.querySelector("input[type='radio']")).toBeNull();
    expect(findByText("button", "Analyze")).toBeUndefined();
    expect(container.textContent).toContain("Analyzing commit 12 of 20");
    expect(container.textContent).toContain("60%");
    expect(container.textContent).toContain("Elapsed time 7.4 seconds");
    expect(container.querySelector("[aria-current='step'] .fa-analyzing__label")?.textContent).toBe("Analyzing");
    expect(container.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("60");
  });

  it("offers Try again when the analysis fails", async () => {
    setDetails({ job, pollError: "Lost the connection." });
    await show();

    expect(container.querySelector("[role='alert']")?.textContent).toBe("Lost the connection.");
    await act(async () => findByText<HTMLButtonElement>("button", "Try again")?.click());
    expect(actions.retry).toHaveBeenCalledOnce();
  });

  it("links to the flow view when the import is ready", async () => {
    setDetails({ job, update: status({ status: "ready", message: "Ready", current: 20, total: 20, seconds: 9 }) });
    await show();

    expect(container.textContent).toContain("Opening the flow in 2 seconds…");
    expect(container.querySelector("a[href='/repo/Flagsmith__flagsmith']")?.textContent).toContain("Open");
  });
});
