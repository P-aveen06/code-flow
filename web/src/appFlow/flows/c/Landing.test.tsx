// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Me, Repo } from "../../../types";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import type { SignInState } from "../../SignInContext";
import { useSignIn } from "../../SignInContext";
import { useLandingJourney } from "../../hooks/useLandingJourney";
import { useLandingRepos } from "../../hooks/useLandingRepos";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState, Piece } from "../../types";
import { LandingC } from "./Landing";

// The provider and the other exports stay real, so the sign-in piece and the sheet behave as in the app.
vi.mock("../../SignInContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../SignInContext")>()),
  useSignIn: vi.fn(),
}));
vi.mock("../../hooks/useLandingJourney", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useLandingJourney")>()),
  useLandingJourney: vi.fn(),
}));
vi.mock("../../hooks/useLandingRepos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useLandingRepos")>()),
  useLandingRepos: vi.fn(),
}));
vi.mock("../../hooks/useMe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useMe")>()),
  useMe: vi.fn(),
}));
vi.mock("../../hooks/useUrlImport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useUrlImport")>()),
  useUrlImport: vi.fn(),
}));

const signedOut: Me = { configured: true, signed_in: false };
const signedIn: Me = {
  configured: true, signed_in: true, login: "demo-user", avatar_url: "", install_url: "https://github.example/apps/code-flow",
};
const demoRepo: Repo = {
  id: "Flagsmith__flagsmith", name: "Flagsmith/flagsmith", url: null, subdir: "api/", branch: "main",
  commit_count: 30, status: "ready", message: "Ready", warning: null, visibility: "public",
};

let root: Root;
let container: HTMLDivElement;
let start: Mock<() => void>;
let openModal: Mock<(error?: string | null) => void>;

function appFlow(signin: Piece): AppFlowState {
  return {
    ready: true,
    reviewerId: "reviewer",
    flow: "c",
    pieces: { ...TODAY_PIECES, landing_layout: "c", signin_layout: signin },
    exposed: false,
    preview: false,
  };
}

// What the landing reads through useSignIn().
function signIn(piece: Piece): SignInState {
  return { piece, start, modalOpen: false, openModal, closeModal: vi.fn(), error: null };
}

// The landing reads only signinError from the journey hook.
function journey(signinError: string | null) {
  return { signinError, signin: {} } as unknown as ReturnType<typeof useLandingJourney>;
}

function importer(): ReturnType<typeof useUrlImport> {
  return {
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
  };
}

async function render(piece: Piece = "c") {
  vi.mocked(useSignIn).mockReturnValue(signIn(piece));
  await act(async () => {
    root.render(<AppFlowTestProvider value={appFlow(piece)}><LandingC /></AppFlowTestProvider>);
  });
}

// The button or link with exactly this text.
function control(text: string): HTMLElement | null {
  return Array.from(container.querySelectorAll<HTMLElement>("button, a"))
    .find((element) => element.textContent?.trim() === text) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/");
  start = vi.fn<() => void>();
  openModal = vi.fn<(error?: string | null) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(useMe).mockReturnValue({ me: { status: "ready", data: signedOut }, refresh: vi.fn(), signOut: vi.fn() });
  vi.mocked(useLandingJourney).mockReturnValue(journey(null));
  vi.mocked(useLandingRepos).mockReturnValue({ repos: { status: "ready", data: [] }, waking: false, reload: vi.fn() });
  vi.mocked(useUrlImport).mockReturnValue(importer());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("LandingC", () => {
  it("reads the landing journey once and shows the headline with the sign-in button", async () => {
    await render();
    expect(useLandingJourney).toHaveBeenCalledTimes(1);
    expect(container.querySelector("h1")?.textContent).toContain("See how a commit");
    expect(control("Sign in with GitHub")).not.toBeNull();
  });

  it("the sign-in button calls useSignIn().start()", async () => {
    await render();
    await act(async () => control("Sign in with GitHub")?.click());
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("signed in, it offers Choose a repository and shows the account", async () => {
    vi.mocked(useMe).mockReturnValue({ me: { status: "ready", data: signedIn }, refresh: vi.fn(), signOut: vi.fn() });
    await render();
    expect(control("Sign in with GitHub")).toBeNull();
    expect(control("Choose a repository")?.getAttribute("href")).toBe("/github");
    expect(container.textContent).toContain("@demo-user");
  });

  it("paste a public URL opens the sign-in sheet on its URL form", async () => {
    await render("c");
    await act(async () => control("paste a public URL")?.click());
    expect(openModal).toHaveBeenCalledTimes(1);
  });

  it("with another sign-in piece, paste a public URL shows the URL form on the landing", async () => {
    await render("today");
    await act(async () => control("paste a public URL")?.click());
    expect(container.querySelector('label[for="import-url"]')?.textContent).toBe("Repository URL");
    expect(openModal).not.toHaveBeenCalled();
  });

  it("today's sign-in piece shows the sign-in error the landing received", async () => {
    vi.mocked(useLandingJourney).mockReturnValue(journey("GitHub sign-in was cancelled."));
    await render("today");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("GitHub sign-in was cancelled.");
  });

  it("lists analyzed repositories, each opening its flow view", async () => {
    vi.mocked(useLandingRepos).mockReturnValue({ repos: { status: "ready", data: [demoRepo] }, waking: false, reload: vi.fn() });
    await render();
    expect(container.textContent).toContain("Flagsmith/flagsmith");
    expect(container.querySelector('a[href="/repo/Flagsmith__flagsmith"]')).not.toBeNull();
  });

  it("says the demo server is waking up while the repositories load", async () => {
    vi.mocked(useLandingRepos).mockReturnValue({ repos: { status: "loading" }, waking: true, reload: vi.fn() });
    await render();
    expect(container.textContent).toContain("Waking up the demo server (about 30 s)…");
  });

  it("says when no repository is analyzed yet", async () => {
    await render();
    expect(container.textContent).toContain("No repositories analyzed yet. Add a GitHub repo to get started.");
  });
});
