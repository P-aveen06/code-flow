// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", mockFetch);
  vi.spyOn(console, "info").mockImplementation(() => {});
  mockFetch.mockReset().mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/me") return Response.json(me);
    if (path === "/api/github/repos") return Response.json(choices);
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

async function open(search = "") {
  window.history.replaceState(null, "", `/${search}`);
  await act(async () => root.render(<App />));
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

  it("lets a signed-in user pick a private repo and import it", async () => {
    me = signedIn;
    await open("?signed_in=1");

    expect(window.location.search).toBe("");
    expect(container.textContent).toContain("Signed in as @octo");
    const select = container.querySelector<HTMLSelectElement>("#picker-repo");
    expect([...select!.options].map((option) => option.textContent)).toEqual(["octo/secret (private)", "octo/open"]);
    expect(container.textContent).toContain("Private: only you will see this import.");

    const subdir = container.querySelector<HTMLInputElement>("#picker-subdir");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(subdir, "api");
      subdir?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLFormElement>(".signin-card form")?.requestSubmit());

    const post = mockFetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(new URL(String(post?.[0])).pathname).toBe("/api/repos");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      github_repo_id: 7, installation_id: 9, subdir: "api", max_commits: 30,
    });
    expect(new Headers(post?.[1]?.headers).get("X-Requested-With")).toBe("code-flow");
  });

  it("asks a signed-in user with no repos to choose some on GitHub", async () => {
    me = signedIn;
    mockFetch.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/me") return Response.json(me);
      return Response.json([]);
    });
    await open();

    const link = [...container.querySelectorAll<HTMLAnchorElement>(".signin-card a")]
      .find((a) => a.textContent === "Choose repositories on GitHub");
    expect(link?.getAttribute("href")).toBe("https://github.com/apps/code-flow/installations/new");
  });

  it("explains a failed sign-in", async () => {
    await open("?signin_error=denied");
    expect(container.querySelector(".signin-error")?.textContent).toBe("GitHub sign-in was cancelled.");
  });
});
