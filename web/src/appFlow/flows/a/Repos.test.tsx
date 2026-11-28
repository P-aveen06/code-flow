// @vitest-environment happy-dom

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { useGitHubRepoList } from "../../hooks/useGitHubRepoList";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState, Pieces } from "../../types";
import { ReposA } from "./Repos";

vi.mock("../../hooks/useGitHubRepoList", () => ({ useGitHubRepoList: vi.fn() }));

type RepoList = ReturnType<typeof useGitHubRepoList>;

const install = "https://github.com/apps/code-flow/installations/new";
const repos = [
  { id: 1001, full_name: "Flagsmith/flagsmith", private: false, default_branch: "main", installation_id: 1 },
  { id: 1002, full_name: "demo-user/payments-api", private: true, default_branch: "main", installation_id: 1 },
];
const signOut = vi.fn();

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.history.replaceState(null, "", "/github");
  signOut.mockReset();
  setRepoList({});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// The signed-in account with the repositories, unless a test overrides part of the list.
function setRepoList(overrides: Partial<RepoList>) {
  vi.mocked(useGitHubRepoList).mockReturnValue({
    me: {
      status: "ready",
      data: { configured: true, signed_in: true, login: "demo-user", avatar_url: "", install_url: install },
    },
    repos: { status: "ready", data: repos },
    installed: false,
    signOut,
    ...overrides,
  });
}

function appState(pieces: Partial<Pieces> = {}): AppFlowState {
  return {
    ready: true, reviewerId: "demo", flow: "a", pieces: { ...TODAY_PIECES, ...pieces }, exposed: false, preview: false,
  };
}

async function show(element: ReactElement, pieces: Partial<Pieces> = {}) {
  await act(async () => root.render(<AppFlowTestProvider value={appState(pieces)}>{element}</AppFlowTestProvider>));
}

function findByText<T extends HTMLElement>(selector: string, text: string): T | undefined {
  return [...container.querySelectorAll<T>(selector)].find((element) => element.textContent?.includes(text));
}

describe("repos page", () => {
  it("lists each repository as a link to its details, with the private badge and default branch", async () => {
    await show(<ReposA search="" />);

    const open = container.querySelector("a[href='/github/1001']");
    expect(open?.textContent).toContain("Flagsmith/flagsmith");
    expect(open?.textContent).toContain("Default branch");
    expect(open?.textContent).toContain("main");
    expect(open?.textContent).not.toContain("Private");
    expect(container.querySelector("a[href='/github/1002']")?.textContent).toContain("Private");
    expect(container.textContent).toContain("@demo-user");
  });

  it("sends the visitor to GitHub to add or remove repositories", async () => {
    await show(<ReposA search="" />);

    expect(findByText("a", "Add or remove repositories")?.getAttribute("href")).toBe(install);
  });

  it("shows the checking state while the sign-in is read", async () => {
    setRepoList({ me: { status: "loading" } });
    await show(<ReposA search="" />);

    expect(container.querySelector("[role='status']")?.textContent).toBe("Checking your GitHub sign-in…");
  });

  it("asks a signed-out visitor to sign in, which opens the sign-in page for flow A", async () => {
    setRepoList({ me: { status: "ready", data: { configured: true, signed_in: false } } });
    await show(<ReposA search="" />, { signin_layout: "a" });

    await act(async () => findByText<HTMLButtonElement>("button", "Sign in with GitHub")?.click());
    expect(window.location.pathname).toBe("/signin");
  });

  it("sends a signed-out visitor to the landing page when sign-in is today's", async () => {
    setRepoList({ me: { status: "ready", data: { configured: true, signed_in: false } } });
    await show(<ReposA search="" />, { signin_layout: "today" });

    await act(async () => findByText<HTMLButtonElement>("button", "Sign in with GitHub")?.click());
    expect(window.location.pathname).toBe("/");
  });

  it("says sign-in is not set up and offers a public URL", async () => {
    setRepoList({ me: { status: "ready", data: { configured: false, signed_in: false } } });
    await show(<ReposA search="" />);

    expect(container.textContent).toContain("GitHub sign-in is not set up on this server.");
    expect(findByText("a", "Paste a public URL instead")?.getAttribute("href")).toBe("/");
  });

  it("shows the loading state while the repositories load", async () => {
    setRepoList({ repos: { status: "loading" } });
    await show(<ReposA search="" />);

    expect(container.querySelector("[role='status']")?.textContent).toBe("Loading your repositories…");
  });

  it("explains that no repository is visible yet, with a link to choose some on GitHub", async () => {
    setRepoList({ repos: { status: "ready", data: [] } });
    await show(<ReposA search="" />);

    expect(container.textContent).toContain("code-flow cannot see any of your repositories yet.");
    expect(findByText("a", "Choose repositories on GitHub")?.getAttribute("href")).toBe(install);
    expect(container.querySelector(".fa-repo-row")).toBeNull();
  });

  it("shows an error with a try-again link", async () => {
    setRepoList({ repos: { status: "error", message: "GitHub is down." } });
    await show(<ReposA search="" />);

    expect(container.querySelector("[role='alert']")?.textContent).toBe("Could not load your repositories.");
    expect(container.textContent).toContain("GitHub is down.");
    expect(findByText("a", "Try again")).toBeDefined();
  });

  it("signs out through the hook", async () => {
    await show(<ReposA search="" />);

    await act(async () => findByText<HTMLButtonElement>("button", "Sign out")?.click());
    expect(signOut).toHaveBeenCalledOnce();
  });
});
