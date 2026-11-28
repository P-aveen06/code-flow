// @vitest-environment happy-dom

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepoChoice, Me } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState } from "../../types";
import { ReposC } from "./Repos";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  signOut: vi.fn(),
  repoList: vi.fn(),
}));

vi.mock("../../hooks/useGitHubRepoList", () => ({
  useGitHubRepoList: () => mocks.repoList(),
}));

vi.mock("../../SignInContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../SignInContext")>()),
  useSignIn: () => ({ start: mocks.start }),
}));

const SIGNED_IN: Me = {
  configured: true,
  signed_in: true,
  login: "demo-user",
  avatar_url: "",
  install_url: "https://github.example/apps/code-flow/installations/new",
};

const REPOS: GitHubRepoChoice[] = [
  { id: 1001, full_name: "Flagsmith/flagsmith", private: false, default_branch: "main", installation_id: 9 },
  { id: 1002, full_name: "demo-user/payments-api", private: true, default_branch: "main", installation_id: 9 },
];

const APP_STATE: AppFlowState = {
  ready: true,
  reviewerId: "demo",
  flow: "c",
  pieces: { ...TODAY_PIECES, repos_layout: "c" },
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
  window.history.replaceState(null, "", "/github");
  mocks.start.mockReset();
  mocks.signOut.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// Sets what the repo list hook returns for the next render.
function givenList(me: RequestState<Me>, repos: RequestState<GitHubRepoChoice[]> = { status: "ready", data: REPOS }) {
  mocks.repoList.mockReturnValue({ me, repos, installed: false, signOut: mocks.signOut });
}

async function show(element: ReactElement = <ReposC search="" />) {
  await act(async () => root.render(<AppFlowTestProvider value={APP_STATE}>{element}</AppFlowTestProvider>));
}

// The link or button with this text.
function control(text: string): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>("a, button"))
    .find((element) => element.textContent?.trim() === text);
  if (!found) throw new Error(`No control reads "${text}"`);
  return found;
}

describe("repos page", () => {
  it("says the GitHub sign-in is being checked", async () => {
    givenList({ status: "loading" });
    await show();
    expect(container.querySelector("[role='status']")?.textContent).toBe("Checking your GitHub sign-in…");
  });

  it("sends a signed-out visitor to sign in", async () => {
    givenList({ status: "ready", data: { configured: true, signed_in: false } });
    await show();
    await act(async () => control("Sign in with GitHub").click());
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("says when GitHub sign-in is not set up, and offers a public URL", async () => {
    givenList({ status: "ready", data: { configured: false, signed_in: false } });
    await show();
    expect(container.textContent).toContain("GitHub sign-in is not set up on this server.");
    expect(control("Paste a public URL instead").getAttribute("href")).toBe("/");
  });

  it("lists each repository as a link to its details, and offers to add or remove repositories", async () => {
    givenList({ status: "ready", data: SIGNED_IN });
    await show();
    const cards = Array.from(container.querySelectorAll<HTMLAnchorElement>(".fc-repos__card"));
    expect(cards.map((card) => card.getAttribute("href"))).toEqual(["/github/1001", "/github/1002"]);
    expect(container.querySelector(".fc-repos__name")?.textContent).toBe("flagsmith");
    expect(control("Add or remove repositories").getAttribute("href")).toBe(SIGNED_IN.install_url);
  });

  it("says when no repository is visible, and offers GitHub to choose them", async () => {
    givenList({ status: "ready", data: SIGNED_IN }, { status: "ready", data: [] });
    await show();
    expect(container.textContent).toContain("code-flow cannot see any of your repositories yet.");
    expect(control("Choose repositories on GitHub").getAttribute("href")).toBe(SIGNED_IN.install_url);
  });

  it("shows a repository error", async () => {
    givenList({ status: "ready", data: SIGNED_IN }, { status: "error", message: "GitHub is unavailable." });
    await show();
    expect(container.querySelector("[role='alert']")?.textContent).toBe("GitHub is unavailable.");
  });

  it("shows the account in the header, and signs out from it", async () => {
    givenList({ status: "ready", data: SIGNED_IN });
    await show();
    expect(container.querySelector(".fc-menu__login")?.textContent).toBe("@demo-user");
    await act(async () => control("Sign out").click());
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });
});
