// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepoChoice } from "../../types";
import { useRepoDetails } from "./useRepoDetails";

vi.mock("../../config", () => ({ apiUrl: "https://flow.test" }));

const repo: GitHubRepoChoice = {
  id: 7, full_name: "octo/secret", private: true, default_branch: "main", installation_id: 9,
};
const analyzedId = "p_1__octo__secret";

let root: Root;
let container: HTMLDivElement;
let details: ReturnType<typeof useRepoDetails>;
// When set, the next import request waits for this response instead of answering at once.
let importGate: Promise<Response> | undefined;
const mockFetch = vi.fn<typeof fetch>();

function Probe({ search }: { search: string }) {
  details = useRepoDetails(repo.id, search);
  return <p data-branch={details.branch} data-subdir={details.subdir} data-busy={String(details.busy)} />;
}

function probeText() {
  const probe = container.querySelector("p");
  return { branch: probe?.dataset.branch, subdir: probe?.dataset.subdir, busy: probe?.dataset.busy };
}

// Lets the branch list, commit list and their state updates settle.
async function settle() {
  for (let round = 0; round < 4; round += 1) await act(async () => {});
}

function requests(method: string, path: string) {
  return mockFetch.mock.calls.filter(([input, init]) => (
    new URL(String(input)).pathname === path && (init?.method ?? "GET") === method
  ));
}

beforeEach(() => {
  importGate = undefined;
  window.history.replaceState(null, "", "/");
  vi.stubEnv("VITE_FLAGSMITH_API_URL", "");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset().mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/github/repos/7/branches") {
      return Response.json({ repo, branches: ["main", "feature/cart"] });
    }
    if (path === "/api/github/repos/7/commits") {
      const params = new URL(String(input)).searchParams;
      return Response.json({
        branch: params.get("branch"), limit: Number(params.get("limit")),
        commits: [{ sha: "a".repeat(40), message: "Latest", author: "octo", date: "2026-11-27T10:00:00Z", url: "" }],
      });
    }
    if (path === "/api/repos" && init?.method === "POST") {
      return importGate ?? Response.json({ id: analyzedId, status: "queued" }, { status: 202 });
    }
    if (path === `/api/repos/${analyzedId}/status`) {
      return Response.json({
        id: analyzedId, name: repo.full_name, status: "ready", message: "Ready", current: null, total: null,
        warning: null, error: null, new_commits: null, seconds: 1,
      });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("repo details branch changes", () => {
  it("opens the requested branch and starts the subfolder empty again on another branch", async () => {
    await act(async () => root.render(<Probe search="?branch=main" />));
    await settle();
    expect(probeText()).toEqual({ branch: "main", subdir: "", busy: "false" });

    await act(async () => details.setSubdir("api"));
    expect(probeText().subdir).toBe("api");

    await act(async () => root.render(<Probe search="?branch=feature%2Fcart" />));
    await settle();
    expect(probeText()).toEqual({ branch: "feature/cart", subdir: "", busy: "false" });
  });

  it("drops an analysis still starting on the old branch so the new branch can be analyzed", async () => {
    let answer!: (response: Response) => void;
    importGate = new Promise<Response>((resolve) => { answer = resolve; });
    await act(async () => root.render(<Probe search="?branch=main" />));
    await settle();
    await act(async () => details.setSubdir("api"));

    await act(async () => details.analyze());
    expect(probeText().busy).toBe("true");
    await act(async () => root.render(<Probe search="?branch=feature%2Fcart" />));
    await settle();
    expect(probeText().busy).toBe("false");

    importGate = undefined;
    await act(async () => answer(Response.json({ id: analyzedId, status: "queued" }, { status: 202 })));
    await settle();
    expect(details.job).toBeNull();
    expect(requests("GET", `/api/repos/${analyzedId}/status`)).toHaveLength(0);

    await act(async () => details.analyze());
    const posts = requests("POST", "/api/repos");
    expect(posts).toHaveLength(2);
    expect(JSON.parse(String(posts[1][1]?.body))).toMatchObject({ branch: "feature/cart", subdir: "" });
  });
});

describe("repo details analysis", () => {
  it("polls the started analysis and opens the repo once it is ready", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Probe search="?branch=main" />));
    await settle();
    await act(async () => details.analyze());
    expect(requests("POST", "/api/repos")).toHaveLength(1);
    expect(details.job).toMatchObject({ id: analyzedId, body: { branch: "main", max_commits: 20 } });

    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(details.update?.status).toBe("ready");
    expect(window.location.pathname).toBe("/");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(window.location.pathname).toBe(`/repo/${analyzedId}`);
  });
});
