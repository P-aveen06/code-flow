// @vitest-environment happy-dom

import flagsmith, { FlagSource } from "@flagsmith/flagsmith";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { AutoSyncResponse, AutoSyncStatus, Repo } from "../types";
import type { SyncMode } from "../view";

vi.mock("../config", () => ({ apiUrl: "https://flow.test" }));
vi.mock("@flagsmith/flagsmith", async (importOriginal) => ({
  ...await importOriginal<typeof import("@flagsmith/flagsmith")>(),
  default: {
    init: vi.fn(async () => {}),
    identify: vi.fn(async () => {}),
    getFlags: vi.fn(async () => {}),
    getContext: vi.fn(() => ({ identity: { identifier: reviewer } })),
    getAllFlags: vi.fn(() => ({ sync_mode: syncFlag() })),
    getExperimentFlag: vi.fn(() => syncFlag()),
    hasFeature: vi.fn((name: string) => name === "variant_preview" && preview),
    flushEvents: vi.fn(),
    get loadingState() { return { source: FlagSource.SERVER, error: null }; },
  },
}));

const github: Repo = {
  id: "Demo__shop", name: "Demo/shop", url: "https://github.com/Demo/shop", subdir: "",
  branch: "main", commit_count: 3, status: "ready", message: "Ready", warning: null,
};
const other = { ...github, id: "Demo__cart", name: "Demo/cart", url: "https://github.com/Demo/cart" };
const local = { ...github, id: "shop-demo", name: "shop-demo", url: null };
const synced: AutoSyncStatus = {
  last_started: "2026-11-26T10:00:00Z", last_finished: "2026-11-26T10:00:01Z",
  last_result: "up_to_date", new_commits: 0, error: null, next_run: null,
  runs: 1, fetches: 1, analysed_commits: 0, seconds: 1, manual_runs: 0,
};

let root: Root;
let container: HTMLDivElement;
let sequence = 0;
let reviewer: string;
let mode: SyncMode;
let preview: boolean;
let settings: AutoSyncResponse;
const mockFetch = vi.fn<typeof fetch>();
const put = vi.fn<(body: unknown) => Promise<Response>>();

function syncFlag() {
  return { enabled: true, value: mode, experiment: { id: 1, name: "Sync mode", inExperiment: true } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T10:03:10Z"));
  vi.stubEnv("VITE_CODEFLOW_FLAGSMITH_ENV_KEY", "test-key");
  vi.stubEnv("VITE_FLAGSMITH_API_URL", "https://flags.test/api/v1/");
  vi.stubEnv("VITE_HOSTED_DEMO", "");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", mockFetch);
  reviewer = `sync-reviewer-${++sequence}`;
  mode = "manual_button";
  preview = false;
  settings = {
    interval_seconds: 300, all: false, repos: {},
    status: { [github.id]: synced },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(flagsmith.getExperimentFlag).mockClear();
  put.mockReset();
  mockFetch.mockReset().mockImplementation(async (request, options) => {
    switch (new URL(String(request)).pathname) {
      case "/api/repos": return Response.json([github, other, local]);
      case "/api/auto-sync":
        return options?.method === "PUT" ? put(JSON.parse(String(options.body))) : Response.json(settings);
      default: throw new Error(`Unexpected request ${String(request)}`);
    }
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function open(search = "") {
  window.history.replaceState(null, "", `/?reviewer=${reviewer}${search}`);
  await act(async () => root.render(<App />));
}

function switches() {
  return [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
}

describe("landing sync variants", () => {
  it("has no switches or sync requests in the manual variant and ignores a disabled preview", async () => {
    await open("&sync=per_repo_toggle");
    expect(switches()).toEqual([]);
    expect(container.textContent).not.toContain("Preview sync");
    expect(mockFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/repos"]);
    expect(flagsmith.getExperimentFlag).toHaveBeenCalledExactlyOnceWith("sync_mode");
  });

  it("puts a switch and a sync status on each imported repo in the per-repo variant", async () => {
    mode = "per_repo_toggle";
    settings.repos[github.id] = true;
    settings.status[other.id] = { ...synced, last_started: "2026-11-26T10:03:09Z" };
    await open();
    expect(switches().map((button) => [button.getAttribute("aria-label"), button.getAttribute("aria-checked")]))
      .toEqual([["Auto-sync for Demo/shop", "true"], ["Auto-sync for Demo/cart", "false"]]);
    expect(switches()[0].closest("li")?.textContent).toContain("Synced 3 min ago");
    expect(switches()[1].closest("li")?.textContent).toContain("Syncing…");
    expect(container.querySelector("li:last-child")?.textContent).not.toContain("Auto-sync");
  });

  it("puts one switch above the repo list in the global variant", async () => {
    mode = "global_toggle";
    settings.all = true;
    settings.status[other.id] = { ...synced, last_result: "error", error: "Repository unavailable" };
    await open();
    const [button] = switches();
    expect(switches()).toHaveLength(1);
    expect(button.textContent).toBe("Auto-sync all repos");
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.closest("li")).toBeNull();
    expect(container.querySelector("ul.repo-list")?.textContent).toContain("Repository unavailable");
  });

  it("previews sync without exposure and returns to the assigned variant", async () => {
    preview = true;
    await open("&sync=per_repo_toggle");
    expect(switches()).toHaveLength(2);
    expect(container.textContent).toContain("not counted in the experiment");
    expect(flagsmith.getExperimentFlag).not.toHaveBeenCalled();
    const global = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent === "Global auto-sync");
    await act(async () => global?.click());
    expect(new URLSearchParams(window.location.search).get("sync")).toBe("global_toggle");
    expect(switches()).toHaveLength(1);
    expect(flagsmith.getExperimentFlag).not.toHaveBeenCalled();
    const back = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Back to my assigned sync");
    await act(async () => back?.click());
    expect(switches()).toHaveLength(0);
    expect(flagsmith.getExperimentFlag).toHaveBeenCalledExactlyOnceWith("sync_mode");
  });

  it.each([
    ["per_repo_toggle", { repos: { [github.id]: true } }],
    ["global_toggle", { all: true }],
  ] as const)("updates the %s switch optimistically, rolls back a failure, then saves", async (variant, body) => {
    mode = variant;
    let finish!: (response: Response) => void;
    put.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await open();
    const [button] = switches();
    expect(button.getAttribute("aria-checked")).toBe("false");

    await act(async () => button.click());
    expect(put).toHaveBeenCalledExactlyOnceWith(body);
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await act(async () => finish(Response.json({ detail: "Disk unavailable" }, { status: 500 })));
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(button.parentElement?.querySelector('[role="alert"]')?.textContent).toContain("Disk unavailable");

    put.mockResolvedValueOnce(Response.json({ ...settings, ...body }));
    await act(async () => button.click());
    expect(put).toHaveBeenLastCalledWith(body);
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.parentElement?.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("hosted landing", () => {
  beforeEach(() => vi.stubEnv("VITE_CODEFLOW_FLAGSMITH_ENV_KEY", ""));

  it("shows the wake-up message after three seconds and clears it when the list arrives", async () => {
    vi.stubEnv("VITE_HOSTED_DEMO", "1");
    let finish!: (response: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await open();

    expect(container.textContent).toContain("Loading repositories…");
    expect(container.textContent).toContain("Imports and new commits on this demo are temporary");
    expect(container.querySelector('a[href="/repo/Flagsmith__flagsmith"]')?.textContent).toContain("Flagsmith/flagsmith (api/)");
    await act(async () => vi.advanceTimersByTimeAsync(2999));
    expect(container.textContent).not.toContain("Waking up the demo server…");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Waking up the demo server…");
    await act(async () => finish(Response.json([local])));
    expect(container.textContent).not.toContain("Waking up the demo server…");
    expect(container.querySelector('a[aria-label="Open shop-demo"]')).not.toBeNull();
  });

  it("retries network and server failures with backoff", async () => {
    vi.stubEnv("VITE_HOSTED_DEMO", "1");
    mockFetch.mockRejectedValueOnce(new Error("offline"));
    mockFetch.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await open();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Waking up the demo server…");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(container.querySelector('a[aria-label="Open shop-demo"]')).not.toBeNull();
  });

  it("keeps the notice off by default", async () => {
    await open();
    expect(container.textContent).not.toContain("Imports and new commits on this demo are temporary");
  });
});
