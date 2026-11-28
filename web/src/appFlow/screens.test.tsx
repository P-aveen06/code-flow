// @vitest-environment happy-dom

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFlowTestProvider } from "./AppFlowProvider";
import {
  BranchSwitchScreen, FlowViewScreen, LandingScreen, RepoDetailsScreen, ReposScreen, SignInScreen,
} from "./screens";
import { TODAY_PIECES } from "./types";
import type { AppFlowState, Pieces } from "./types";

vi.mock("../pages/Landing", () => ({ Landing: () => "Today landing", readSigninError: () => null }));
vi.mock("../pages/GitHubRepos", () => ({ GitHubRepos: () => "Today repos" }));
vi.mock("../pages/GitHubRepo", () => ({ GitHubRepoPage: () => "Today repo details" }));
vi.mock("../pages/Viewer", () => ({ Viewer: () => "Today flow view" }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.history.replaceState(null, "", "/");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function appState(pieces: Partial<Pieces> = {}): AppFlowState {
  return {
    ready: true, reviewerId: "demo", flow: null, pieces: { ...TODAY_PIECES, ...pieces }, exposed: false, preview: false,
  };
}

async function show(element: ReactElement, state: AppFlowState) {
  await act(async () => root.render(<AppFlowTestProvider value={state}>{element}</AppFlowTestProvider>));
}

describe("landing screen", () => {
  it("shows today's landing for the today piece", async () => {
    await show(<LandingScreen />, appState());
    expect(container.textContent).toBe("Today landing");
  });

  it.each([
    ["a", "Flow A · Landing is being built."],
    ["b", "Flow B · Landing is being built."],
    ["c", "Flow C · Landing is being built."],
  ] as const)("shows flow %s's landing", async (piece, text) => {
    await show(<LandingScreen />, appState({ landing_layout: piece }));
    expect(container.textContent).toBe(text);
  });
});

describe("sign-in screen", () => {
  it("shows the sign-in page for flow A", async () => {
    window.history.replaceState(null, "", "/signin");
    await show(<SignInScreen />, appState({ signin_layout: "a" }));
    expect(container.textContent).toBe("Flow A · Sign in is being built.");
    expect(window.location.pathname).toBe("/signin");
  });

  it.each(["today", "b", "c"] as const)("sends %s back to the landing page", async (piece) => {
    window.history.replaceState(null, "", "/signin");
    await show(<SignInScreen />, appState({ signin_layout: piece }));
    expect(container.textContent).toBe("");
    expect(window.location.pathname).toBe("/");
  });
});

describe("repos screen", () => {
  it("shows today's repos, and flow C's repos for c", async () => {
    await show(<ReposScreen search="" />, appState());
    expect(container.textContent).toBe("Today repos");

    await show(<ReposScreen search="" />, appState({ repos_layout: "c" }));
    expect(container.textContent).toBe("Flow C · Repos is being built.");
  });
});

describe("repo details screen", () => {
  it("shows today's repo details, and flow B's for b", async () => {
    await show(<RepoDetailsScreen repoId={7} search="" />, appState());
    expect(container.textContent).toBe("Today repo details");

    await show(<RepoDetailsScreen repoId={7} search="" />, appState({ repo_details_layout: "b" }));
    expect(container.textContent).toBe("Flow B · Repo details is being built.");
  });
});

describe("flow view screen", () => {
  it("shows today's viewer, and flow A's flow view for a", async () => {
    await show(<FlowViewScreen id="repo" search="" />, appState());
    expect(container.textContent).toBe("Today flow view");

    await show(<FlowViewScreen id="repo" search="" />, appState({ flow_view_layout: "a" }));
    expect(container.textContent).toBe("Flow A · Flow view is being built.");
  });
});

describe("branch switch screen", () => {
  it("links to the repo picker today", async () => {
    await show(<BranchSwitchScreen repoId="repo" currentBranch="main" />, appState());
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("Switch branch");
    expect(link?.getAttribute("href")).toBe("/github");
  });

  it("shows the flow's own trigger for a flow", async () => {
    await show(<BranchSwitchScreen repoId="repo" currentBranch="main" />, appState({ branch_switch: "b" }));
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("button")?.textContent).toBe("Switch branch");
  });
});

describe("each screen follows its own switch", () => {
  it("keeps today's repos when only the landing piece is a flow", async () => {
    await show(<ReposScreen search="" />, appState({ landing_layout: "a" }));
    expect(container.textContent).toBe("Today repos");
  });
});
