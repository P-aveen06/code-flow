// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signInUrl } from "../../../api";
import { startSignIn } from "../../../pages/SignInImport";
import type { Me } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState } from "../../types";
import { SignInPageA } from "./SignIn";

vi.mock("../../hooks/useMe", () => ({ useMe: vi.fn() }));
vi.mock("../../hooks/useUrlImport", () => ({ useUrlImport: vi.fn() }));
vi.mock("../../../pages/SignInImport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../pages/SignInImport")>()),
  startSignIn: vi.fn(),
}));

const signedOut: Me = { configured: true, signed_in: false };
const signedIn: Me = {
  configured: true, signed_in: true, login: "demo-user", avatar_url: "", install_url: "https://github.com/apps/code-flow",
};

const signOutSpy = vi.fn(async () => undefined);

const appState: AppFlowState = {
  ready: true,
  reviewerId: "demo",
  flow: "a",
  pieces: { ...TODAY_PIECES, signin_layout: "a" },
  exposed: false,
  preview: false,
};

function givenAccount(me: RequestState<Me>) {
  vi.mocked(useMe).mockReturnValue({ me, refresh: vi.fn(), signOut: signOutSpy });
}

// Stops the anchor's default navigation, which happy-dom cannot perform.
function preventNavigation(event: Event) {
  event.preventDefault();
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  document.addEventListener("click", preventNavigation);
  givenAccount({ status: "ready", data: signedOut });
  vi.mocked(useUrlImport).mockReturnValue({
    fields: { url: "", subdir: "", maxCommits: "30" },
    edit: vi.fn(),
    formError: null,
    submit: vi.fn(),
    busy: false,
    submitting: false,
    job: null,
    update: undefined,
    pollError: null,
    retry: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.removeEventListener("click", preventNavigation);
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function show() {
  await act(async () => root.render(
    <AppFlowTestProvider value={appState}>
      <SignInPageA />
    </AppFlowTestProvider>,
  ));
}

function buttonWithText(text: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

describe("Flow A sign-in page", () => {
  it("signs in with the same GitHub link as today's card, on the first step", async () => {
    await show();

    const link = container.querySelector<HTMLAnchorElement>("a.fa-signin__primary");
    expect(link?.getAttribute("href")).toBe(signInUrl());
    expect(container.querySelector("[aria-current='step']")?.textContent).toContain("Sign in");

    await act(async () => link?.click());
    expect(startSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows a signed-in account, Choose a repository and Sign out", async () => {
    givenAccount({ status: "ready", data: signedIn });
    await show();

    expect(container.textContent).toContain("Signed in as @demo-user");
    expect(container.querySelector("a[href='/github']")?.textContent).toContain("Choose a repository");
    expect(container.querySelector("[aria-current='step']")?.textContent).toContain("Choose a repo");

    await act(async () => buttonWithText("Sign out")?.click());
    expect(signOutSpy).toHaveBeenCalledTimes(1);
  });

  it("offers the public URL form when GitHub sign-in is not set up", async () => {
    givenAccount({ status: "ready", data: { configured: false, signed_in: false } });
    await show();

    expect(container.textContent).toContain("GitHub sign-in is not set up on this server yet.");
    expect(container.querySelector("#import-url")).toBeNull();

    await act(async () => buttonWithText("Paste a public URL")?.click());
    expect(container.querySelector("#import-url")).not.toBeNull();
  });

  it("says it is checking the sign-in while the account loads", async () => {
    givenAccount({ status: "loading" });
    await show();

    expect(container.querySelector("[role='status']")?.textContent).toBe("Checking your GitHub sign-in…");
  });

  it("shows the message of a failed sign-in from the address", async () => {
    window.history.replaceState(null, "", "/signin?signin_error=denied");
    await show();

    expect(container.querySelector("[role='alert']")?.textContent).toBe("GitHub sign-in was cancelled.");
  });
});
