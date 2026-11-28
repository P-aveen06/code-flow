// @vitest-environment happy-dom

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepoChoice, Me } from "../../../types";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { useGitHubRepoList } from "../../hooks/useGitHubRepoList";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState, Pieces } from "../../types";
import { ReposB } from "./Repos";

vi.mock("../../hooks/useGitHubRepoList", () => ({ useGitHubRepoList: vi.fn() }));

const installUrl = "https://github.com/apps/code-flow/installations/new";
const account: Me = { configured: true, signed_in: true, login: "demo-user", avatar_url: "", install_url: installUrl };
const signedOut: Me = { configured: true, signed_in: false };
const flagsmith: GitHubRepoChoice = { id: 1001, full_name: "Flagsmith/flagsmith", private: false, default_branch: "main", installation_id: 1 };
const payments: GitHubRepoChoice = { id: 1002, full_name: "demo-user/payments-api", private: true, default_branch: "main", installation_id: 1 };

type RepoList = ReturnType<typeof useGitHubRepoList>;

function listing(overrides: Partial<RepoList> = {}): RepoList {
  return {
    me: { status: "ready", data: account },
    repos: { status: "ready", data: [flagsmith, payments] },
    installed: false,
    signOut: vi.fn(),
    ...overrides,
  };
}

function appState(pieces: Partial<Pieces> = {}): AppFlowState {
  return {
    ready: true, reviewerId: "demo", flow: "b", pieces: { ...TODAY_PIECES, ...pieces }, exposed: false, preview: false,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.history.replaceState(null, "", "/github");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function show(state: AppFlowState = appState()) {
  const element: ReactElement = <ReposB search="" />;
  await act(async () => root.render(<AppFlowTestProvider value={state}>{element}</AppFlowTestProvider>));
}

function button(label: string) {
  return [...container.querySelectorAll("button, a")].find((element) => element.textContent?.includes(label));
}

describe("flow B repositories page", () => {
  it("says the account is being checked while it loads", async () => {
    vi.mocked(useGitHubRepoList).mockReturnValue(listing({
      me: { status: "loading" }, repos: { status: "loading" },
    }));
    await show();
    expect(container.querySelector("[role='status']")?.textContent).toBe("Checking your GitHub sign-in…");
  });

  it.each([
    ["a", "/signin"],
    ["b", "/"],
  ] as const)("sends a signed-out visitor to sign in with flow %s's sign-in piece", async (piece, path) => {
    vi.mocked(useGitHubRepoList).mockReturnValue(listing({ me: { status: "ready", data: signedOut } }));
    await show(appState({ signin_layout: piece }));
    await act(async () => button("Sign in with GitHub")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(window.location.pathname).toBe(path);
  });

  it("links a signed-out visitor to the landing page when sign-in is today's", async () => {
    vi.mocked(useGitHubRepoList).mockReturnValue(listing({ me: { status: "ready", data: signedOut } }));
    await show(appState({ signin_layout: "today" }));
    expect(button("Sign in with GitHub")?.getAttribute("href")).toBe("/");
  });

  it("offers the GitHub app install when no repository is visible yet", async () => {
    vi.mocked(useGitHubRepoList).mockReturnValue(listing({ repos: { status: "ready", data: [] } }));
    await show();
    expect(container.textContent).toContain("code-flow cannot see any of your repositories yet.");
    expect(button("Choose repositories on GitHub")?.getAttribute("href")).toBe(installUrl);
  });

  it("lists each repository as a row that opens its details, with the add or remove link", async () => {
    vi.mocked(useGitHubRepoList).mockReturnValue(listing());
    await show();
    expect(container.querySelector("a[href='/github/1001']")?.textContent).toBe("Flagsmith/flagsmith");
    expect(container.querySelector("a[href='/github/1002']")?.textContent).toBe("demo-user/payments-api");
    expect(container.textContent).toContain("Private");
    expect(button("Add or remove repositories")?.getAttribute("href")).toBe(installUrl);
  });

  it("asks for the repositories again when a load fails and Try again is pressed", async () => {
    const hook = vi.mocked(useGitHubRepoList);
    hook.mockReturnValue(listing({ repos: { status: "error", message: "Cannot reach the code-flow server." } }));
    await show();
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Cannot reach the code-flow server.");

    const calls = hook.mock.calls.length;
    await act(async () => button("Try again")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(hook.mock.calls.length).toBeGreaterThan(calls);
  });

  it("signs out through the account in the sidebar", async () => {
    const signOut = vi.fn();
    vi.mocked(useGitHubRepoList).mockReturnValue(listing({ signOut }));
    await show();
    expect(container.querySelector(".fb-sidebar__account")?.textContent).toContain("@demo-user");
    await act(async () => button("Sign out")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
