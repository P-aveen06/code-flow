// @vitest-environment happy-dom

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, Repo } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { useSignIn } from "../../SignInContext";
import { useLandingJourney } from "../../hooks/useLandingJourney";
import { useLandingRepos } from "../../hooks/useLandingRepos";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState, Pieces } from "../../types";
import { LandingA } from "./Landing";

vi.mock("../../hooks/useLandingJourney", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useLandingJourney")>()),
  useLandingJourney: vi.fn(),
}));
vi.mock("../../hooks/useMe", () => ({ useMe: vi.fn() }));
vi.mock("../../hooks/useLandingRepos", () => ({ useLandingRepos: vi.fn() }));
vi.mock("../../hooks/useUrlImport", () => ({ useUrlImport: vi.fn() }));
vi.mock("../../SignInContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../SignInContext")>()),
  useSignIn: vi.fn(),
}));

const signedOut: Me = { configured: true, signed_in: false };
const signedIn: Me = {
  configured: true, signed_in: true, login: "demo-user", avatar_url: "", install_url: "https://github.com/apps/code-flow",
};

const flagsmith: Repo = {
  id: "Flagsmith__flagsmith", name: "Flagsmith/flagsmith", url: null, subdir: "api", branch: "main",
  commit_count: 50, status: "ready", message: "Ready", warning: null, visibility: "public",
};
const payments: Repo = {
  id: "demo-user__payments-api", name: "demo-user/payments-api", url: null, subdir: null, branch: "main",
  commit_count: 12, status: "analyzing", message: "Analyzing", warning: null, visibility: "private",
};

const startSpy = vi.fn();
const signOutSpy = vi.fn(async () => undefined);
const submitSpy = vi.fn();
const editSpy = vi.fn();
const retrySpy = vi.fn();

const pieces: Pieces = { ...TODAY_PIECES, landing_layout: "a", signin_layout: "a" };
const appState: AppFlowState = {
  ready: true, reviewerId: "demo", flow: "a", pieces, exposed: false, preview: false,
};

function givenAccount(me: RequestState<Me>) {
  vi.mocked(useMe).mockReturnValue({ me, refresh: vi.fn(), signOut: signOutSpy });
}

function givenRepos(repos: RequestState<Repo[]>, waking = false) {
  vi.mocked(useLandingRepos).mockReturnValue({ repos, waking, reload: vi.fn() });
}

function givenImport(overrides: Partial<ReturnType<typeof useUrlImport>> = {}) {
  vi.mocked(useUrlImport).mockReturnValue({
    fields: { url: "", subdir: "", maxCommits: "30" },
    edit: editSpy,
    formError: null,
    submit: submitSpy,
    busy: false,
    submitting: false,
    job: null,
    update: undefined,
    pollError: null,
    retry: retrySpy,
    ...overrides,
  });
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(useSignIn).mockReturnValue({
    piece: "a", start: startSpy, modalOpen: false, openModal: vi.fn(), closeModal: vi.fn(), error: null,
  });
  vi.mocked(useLandingJourney).mockReturnValue({ signinError: null, signin: {} as ReturnType<typeof useLandingJourney>["signin"] });
  givenAccount({ status: "ready", data: signedOut });
  givenRepos({ status: "ready", data: [] });
  givenImport();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function show(element: ReactElement, state: AppFlowState = appState) {
  await act(async () => root.render(<AppFlowTestProvider value={state}>{element}</AppFlowTestProvider>));
}

function buttonWithText(text: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

describe("Flow A landing", () => {
  it("starts the sign-in piece from its main button and links to no GitHub page itself", async () => {
    await show(<LandingA />);

    await act(async () => buttonWithText("Sign in with GitHub")?.click());

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector("a[href*='auth/github']")).toBeNull();
  });

  it("sends a signed-in visitor to choose a repository, with the account in the header", async () => {
    givenAccount({ status: "ready", data: signedIn });
    await show(<LandingA />);

    expect(container.querySelector(".fa-landing__login")?.textContent).toBe("@demo-user");
    expect(container.querySelector("a[href='/github']")?.textContent).toContain("Choose a repository");
    expect(buttonWithText("Sign in with GitHub")).toBeUndefined();

    await act(async () => buttonWithText("Sign out")?.click());
    expect(signOutSpy).toHaveBeenCalledTimes(1);
  });

  it("calls useLandingJourney once", async () => {
    await show(<LandingA />);

    expect(useLandingJourney).toHaveBeenCalledTimes(1);
  });

  it("lists the analyzed repositories, with a private badge and the open link of each", async () => {
    givenRepos({ status: "ready", data: [flagsmith, payments] });
    await show(<LandingA />);

    expect(container.textContent).toContain("api/ · 50 commits");
    expect(container.querySelector("[title='Only you can see this import']")?.textContent).toContain("Private");
    expect(container.querySelector("a[aria-label='Open Flagsmith/flagsmith']")?.getAttribute("href"))
      .toBe("/repo/Flagsmith__flagsmith");
    expect(container.querySelector("a[aria-label='Open demo-user/payments-api']")).not.toBeNull();
    expect(container.textContent).toContain("Analyzing…");
  });

  it("says that repositories are loading, and that none are analyzed yet", async () => {
    givenRepos({ status: "loading" });
    await show(<LandingA />);
    expect(container.querySelector("[role='status']")?.textContent).toBe("Loading repositories…");

    givenRepos({ status: "ready", data: [] });
    await show(<LandingA />);
    expect(container.textContent).toContain("No repositories analyzed yet. Add a GitHub repo to get started.");
  });

  it("submits the pasted public URL through the import hook and shows its validation error", async () => {
    givenImport({
      formError: { field: "url", message: "Enter a public GitHub repository URL like https://github.com/owner/repo." },
    });
    await show(<LandingA />);

    const form = container.querySelector<HTMLFormElement>("#public-url-form form");
    expect(container.querySelector("#import-url")?.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector("#import-error [role='alert']")?.textContent)
      .toContain("Enter a public GitHub repository URL");

    await act(async () => form?.requestSubmit());
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the progress of a running import and offers Try again when it fails", async () => {
    const job = { id: "demo-user__payments-api", status: "analyzing" as const, body: { url: "", subdir: "", max_commits: 20 } };
    const update = {
      id: "demo-user__payments-api", status: "analyzing" as const, name: "demo-user/payments-api", message: "",
      current: 12, total: 20, warning: null, error: null, new_commits: null, seconds: 7.4,
    };
    givenImport({ job, update });
    await show(<LandingA />);
    expect(container.querySelector("[role='status'].fa-entry__progress-text")?.textContent).toBe("Analyzing commit 12 of 20");
    expect(container.textContent).toContain("Elapsed time 7.4 seconds");

    givenImport({ job, pollError: "Could not check the import status." });
    await show(<LandingA />);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Could not check the import status.");
    await act(async () => buttonWithText("Try again")?.click());
    expect(retrySpy).toHaveBeenCalledTimes(1);
  });

  it("shows a failed sign-in here when the sign-in piece does not forward it", async () => {
    vi.mocked(useLandingJourney).mockReturnValue({
      signinError: "GitHub sign-in was cancelled.",
      signin: {} as ReturnType<typeof useLandingJourney>["signin"],
    });
    const today: AppFlowState = { ...appState, pieces: { ...pieces, signin_layout: "today" } };
    await show(<LandingA />, today);

    expect(container.querySelector("[role='alert']")?.textContent).toBe("GitHub sign-in was cancelled.");
    expect(container.querySelector("#import")).not.toBeNull();
  });
});
