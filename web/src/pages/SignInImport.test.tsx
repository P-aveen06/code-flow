// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { beginJourney, markRedirecting, readJourney } from "../signinEvents";
import type { GitHubRepoChoice, Me } from "../types";

vi.mock("../config", () => ({ apiUrl: "https://flow.test" }));

const signedOut: Me = { configured: true, signed_in: false };
const signedIn: Me = {
  configured: true, signed_in: true, login: "octo", avatar_url: "", install_url: "https://github.com/apps/code-flow/installations/new",
};
const choices: GitHubRepoChoice[] = [
  { id: 7, full_name: "octo/secret", private: true, default_branch: "main", installation_id: 9 },
  { id: 8, full_name: "octo/open", private: false, default_branch: "main", installation_id: 9 },
];

let root: Root;
let container: HTMLDivElement;
let me: Me;
const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  me = signedOut;
  window.sessionStorage.clear();
  vi.stubEnv("VITE_HOSTED_DEMO", "");
  vi.stubEnv("VITE_GITHUB_SIGNIN_FALLBACK", "github_signin");
  vi.stubEnv("VITE_FLAGSMITH_API_URL", "");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", mockFetch);
  vi.spyOn(console, "info").mockImplementation(() => {});
  mockFetch.mockReset().mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/me") return Response.json(me);
    if (path === "/api/github/repos") return Response.json(choices);
    if (path === "/api/github/repos/7/branches") return Response.json({ repo: choices[0], branches: ["main", "feature/cart"] });
    if (path === "/api/github/repos/7/commits") {
      const params = new URL(String(input)).searchParams;
      const branch = params.get("branch") ?? "";
      return Response.json({
        branch, limit: Number(params.get("limit")),
        commits: [0, 1, 2].map((n) => ({
          sha: `${n}`.repeat(40), message: `${branch} commit ${n}`, author: "octo", date: "2026-11-27T10:00:00Z", url: "",
        })),
      });
    }
    if (path.startsWith("/api/github/repos/")) {
      return Response.json({ detail: "Repository not found, or code-flow has no access to it" }, { status: 404 });
    }
    if (path === "/api/repos" && init?.method === "POST") return Response.json({ id: "p_1__octo__secret", status: "queued" }, { status: 202 });
    if (path === "/api/repos") return Response.json([]);
    return Response.json({ status: "queued", id: "p_1__octo__secret" });
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(search = "", pathname = "/") {
  window.history.replaceState(null, "", `${pathname}${search}`);
  await act(async () => root.render(<App />));
}

function commitRequests() {
  return mockFetch.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === "/api/github/repos/7/commits")
    .map((url) => Object.fromEntries(url.searchParams));
}

describe("Sign in with GitHub variant", () => {
  it("offers sign-in first and keeps the public URL form one click away", async () => {
    await open();

    const signIn = container.querySelector<HTMLAnchorElement>(".signin-card a.btn--primary");
    expect(signIn?.textContent).toBe("Sign in with GitHub");
    expect(signIn?.getAttribute("href")).toBe("https://flow.test/api/auth/github/login");
    expect(container.querySelector("#import-url")).toBeNull();

    const useUrl = [...container.querySelectorAll("button")].find((b) => b.textContent === "or paste a public URL");
    await act(async () => useUrl?.click());
    expect(container.querySelector("#import-url")).not.toBeNull();
  });

  it("sends a signed-in visitor to their repositories page", async () => {
    me = signedIn;
    await open();

    expect(container.textContent).toContain("Signed in as @octo");
    const choose = [...container.querySelectorAll<HTMLAnchorElement>(".signin-card a")]
      .find((a) => a.textContent === "Choose a repository");
    expect(choose?.getAttribute("href")).toBe("/github");
    await act(async () => choose?.click());
    expect(window.location.pathname).toBe("/github");
    expect(container.querySelector("#github-repos-title")).not.toBeNull();
  });

  it("lists the signed-in user's repositories after sign-in", async () => {
    me = signedIn;
    beginJourney("reviewer-1", "github_signin", false);
    markRedirecting();
    await open("?signed_in=1", "/github");

    expect(window.location.search).toBe("");
    expect(container.textContent).toContain("Signed in as @octo");
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".github-repos a")];
    expect(links.map((a) => [a.getAttribute("href"), a.querySelector("strong")?.textContent])).toEqual([
      ["/github/7", "octo/secret"], ["/github/8", "octo/open"],
    ]);
    expect(links[0].textContent).toContain("Private");
    expect(readJourney()).toMatchObject({ redirecting: false, sent: ["signin_completed"] });
  });

  it("asks a signed-in user with no repos to choose some on GitHub", async () => {
    me = signedIn;
    mockFetch.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/me") return Response.json(me);
      return Response.json([]);
    });
    await open("", "/github");

    const link = [...container.querySelectorAll<HTMLAnchorElement>(".github-card a")]
      .find((a) => a.textContent === "Choose repositories on GitHub");
    expect(link?.getAttribute("href")).toBe("https://github.com/apps/code-flow/installations/new");
  });

  it("shows a branch's latest commits and analyzes the chosen branch", async () => {
    me = signedIn;
    await open("?branch=feature%2Fcart", "/github/7");

    const select = container.querySelector<HTMLSelectElement>("#github-branch");
    expect([...select!.options].map((option) => option.textContent)).toEqual(["main (default)", "feature/cart"]);
    expect(select?.value).toBe("feature/cart");
    expect(commitRequests()).toEqual([{ branch: "feature/cart", limit: "20" }]);
    expect(container.querySelector("h2")?.textContent).toBe("Latest 3 commits on feature/cart");
    expect([...container.querySelectorAll(".branch-commits__message")].map((m) => m.textContent)).toEqual([
      "feature/cart commit 0", "feature/cart commit 1", "feature/cart commit 2",
    ]);
    expect(container.textContent).toContain("Private: only you will see what you analyze here.");

    await act(async () => container.querySelector<HTMLFormElement>(".github-card form")?.requestSubmit());
    const post = mockFetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(new URL(String(post?.[0])).pathname).toBe("/api/repos");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      github_repo_id: 7, installation_id: 9, branch: "feature/cart", subdir: "", max_commits: 20,
    });
    expect(new Headers(post?.[1]?.headers).get("X-Requested-With")).toBe("code-flow");
  });

  it("reloads the commits when the branch changes", async () => {
    me = signedIn;
    await open("", "/github/7");
    expect(commitRequests()).toEqual([{ branch: "main", limit: "20" }]);

    const select = container.querySelector<HTMLSelectElement>("#github-branch");
    await act(async () => {
      select!.value = "feature/cart";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(window.location.search).toBe("?branch=feature%2Fcart");
    expect(commitRequests()).toEqual([{ branch: "main", limit: "20" }, { branch: "feature/cart", limit: "20" }]);
  });

  it("explains a repository the user cannot open", async () => {
    me = signedIn;
    await open("", "/github/99");
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "Repository not found, or code-flow has no access to it",
    );
  });

  it("explains a failed sign-in", async () => {
    await open("?signin_error=denied");
    expect(container.querySelector(".signin-error")?.textContent).toBe("GitHub sign-in was cancelled.");
  });
});
