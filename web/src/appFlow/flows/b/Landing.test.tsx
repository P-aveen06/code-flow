// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Me, Repo } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { useLandingJourney } from "../../hooks/useLandingJourney";
import { useLandingRepos } from "../../hooks/useLandingRepos";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState, Pieces } from "../../types";
import { LandingB } from "./Landing";

vi.mock("../../hooks/useLandingJourney", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useLandingJourney")>()),
  useLandingJourney: vi.fn(),
}));
vi.mock("../../hooks/useLandingRepos", () => ({ useLandingRepos: vi.fn(), announceReposChanged: vi.fn() }));
vi.mock("../../hooks/useMe", () => ({ useMe: vi.fn() }));
vi.mock("../../hooks/useUrlImport", () => ({ useUrlImport: vi.fn() }));

const signedOut: Me = { configured: true, signed_in: false };
const signedIn: Me = {
  configured: true, signed_in: true, login: "octo", avatar_url: "", install_url: "https://github.com/apps/code-flow/installations/new",
};

const flagsmith: Repo = {
  id: "Flagsmith__flagsmith", name: "Flagsmith/flagsmith", url: null, subdir: "api", branch: "main", commit_count: 50,
  status: "ready", message: "Ready", warning: null, visibility: "public",
};
const payments: Repo = {
  id: "p_1__demo-user__payments-api", name: "demo-user/payments-api", url: null, subdir: null, branch: "main",
  commit_count: 12, status: "analyzing", message: "Analyzing", warning: null, visibility: "private",
};
const queued: Repo = {
  id: "p_2__demo-user__ml", name: "demo-user/ml-pipelines", url: null, subdir: null, branch: "main", commit_count: 0,
  status: "queued", message: "Queued", warning: null, visibility: "private",
};

let root: Root;
let container: HTMLDivElement;
let signOut: Mock<() => Promise<void>>;
let reload: Mock<() => void>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  signOut = vi.fn<() => Promise<void>>(async () => {});
  reload = vi.fn<() => void>();
  vi.mocked(useLandingJourney).mockReturnValue(journey());
  vi.mocked(useMe).mockReturnValue(account({ status: "ready", data: signedOut }));
  vi.mocked(useLandingRepos).mockReturnValue({ repos: { status: "ready", data: [flagsmith] }, waking: false, reload });
  vi.mocked(useUrlImport).mockReturnValue(urlImport());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function journey(signinError: string | null = null) {
  return { signinError, signin: { ready: true } } as unknown as ReturnType<typeof useLandingJourney>;
}

function account(me: RequestState<Me>): ReturnType<typeof useMe> {
  return { me, refresh: vi.fn(), signOut } as unknown as ReturnType<typeof useMe>;
}

function urlImport(overrides: Partial<ReturnType<typeof useUrlImport>> = {}): ReturnType<typeof useUrlImport> {
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
    ...overrides,
  };
}

// The app flow state of a landing that is flow B, with the sign-in piece and the others as given.
function appFlow(pieces: Partial<Pieces> = {}): AppFlowState {
  return {
    ready: true,
    reviewerId: "",
    flow: "b",
    pieces: { ...TODAY_PIECES, landing_layout: "b", signin_layout: "b", ...pieces },
    exposed: false,
    preview: false,
  };
}

async function open(search = "", pieces?: Partial<Pieces>) {
  window.history.replaceState(null, "", `/${search}`);
  await act(async () => root.render(
    <AppFlowTestProvider value={appFlow(pieces)}>
      <LandingB />
    </AppFlowTestProvider>,
  ));
}

function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

function link(text: string) {
  const found = [...container.querySelectorAll("a")].find((item) => item.textContent === text);
  if (!found) throw new Error(`No link "${text}"`);
  return found;
}

describe("flow B landing", () => {
  it("shows the headline, the Flagsmith demo and the sign-in panel beside the product picture", async () => {
    await open();

    expect(container.querySelector("h1")?.textContent).toContain("See how a commit changes");
    expect(container.querySelector("h1")?.textContent).toContain("your code’s flow");
    expect(link("Open the Flagsmith demo").getAttribute("href")).toBe("/repo/Flagsmith__flagsmith?commit=47c774b");
    expect(container.querySelector(".fb-landing__shot img")?.getAttribute("src")).toBe("/four-sections-overview.webp");
    expect(container.querySelector("#signin-panel")?.closest(".fb-landing__aside")).not.toBeNull();
  });

  it("points the panel's sign-in button at GitHub's login, the sign-in piece's own link", async () => {
    await open();

    const signIn = container.querySelector<HTMLAnchorElement>("#signin-panel a.btn--primary");
    expect(signIn?.textContent).toBe("Sign in with GitHub");
    expect(signIn?.getAttribute("href")).toMatch(/\/api\/auth\/github\/login$/);
  });

  it("lists the analyzed repositories, their status, and which ones open", async () => {
    vi.mocked(useLandingRepos).mockReturnValue({ repos: { status: "ready", data: [flagsmith, payments, queued] }, waking: false, reload });
    await open();

    const rows = [...container.querySelectorAll("[role=row]")].slice(1);
    expect(rows.map((row) => row.querySelector(".fb-landing__repo-name")?.textContent)).toEqual([
      "Flagsmith/flagsmith", "demo-user/payments-api", "demo-user/ml-pipelines",
    ]);
    expect([...container.querySelectorAll(".fb-landing__status")].map((chip) => chip.textContent)).toEqual([
      "Ready", "Analyzing…", "Queued",
    ]);
    expect(container.querySelector(".fb-landing__badge")?.textContent).toContain("Private");
    expect(container.querySelector('a[aria-label="Open Flagsmith/flagsmith"]')?.getAttribute("href"))
      .toBe("/repo/Flagsmith__flagsmith");
    expect(container.querySelector('a[aria-label="Open demo-user/payments-api"]')?.getAttribute("href"))
      .toBe(`/repo/${payments.id}`);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Open demo-user/ml-pipelines"]')?.disabled).toBe(true);
  });

  it("says so when no repository is analyzed yet", async () => {
    vi.mocked(useLandingRepos).mockReturnValue({ repos: { status: "ready", data: [] }, waking: false, reload });
    await open();

    expect(container.textContent).toContain("No repositories analyzed yet. Add a GitHub repo to get started.");
  });

  it("explains the wait while the hosted demo server wakes up", async () => {
    vi.mocked(useLandingRepos).mockReturnValue({ repos: { status: "loading" }, waking: true, reload });
    await open();

    expect(container.querySelector('[role="status"]')?.textContent).toBe("Waking up the demo server (about 30 s)…");
    expect(container.querySelector('progress[aria-label="Demo server startup"]')).not.toBeNull();
  });

  it("sends a signed-in visitor to their repositories and signs out from the top bar", async () => {
    vi.mocked(useMe).mockReturnValue(account({ status: "ready", data: signedIn }));
    await open();

    expect(container.querySelector(".fb-landing__login")?.textContent).toBe("@octo");
    expect(link("Choose a repository").getAttribute("href")).toBe("/github");
    await act(async () => button("Sign out").click());
    expect(signOut).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("explains a failed sign-in in the panel", async () => {
    await open("?signin_error=denied");

    expect(container.querySelector("#signin-panel [role=alert]")?.textContent).toBe("GitHub sign-in was cancelled.");
  });

  it("sends a flow A visitor's sign-in from the landing card to the sign-in page", async () => {
    await open("", { signin_layout: "a" });

    expect(container.querySelector("#signin-panel")).toBeNull();
    await act(async () => button("Sign in with GitHub").click());
    expect(window.location.pathname).toBe("/signin");
  });

  it("opens the paste-a-URL form from another flow's card, and goes back to the card", async () => {
    await open("", { signin_layout: "c" });

    await act(async () => button("or paste a public URL").click());
    expect(container.querySelector("#import-url")).not.toBeNull();
    expect(container.textContent).toContain("Analyze a public repository");

    await act(async () => button("Sign in with GitHub instead").click());
    expect(container.querySelector("#import-url")).toBeNull();
    expect(button("Sign in with GitHub")).toBeDefined();
  });

  it("keeps today's sign-in card, and shows its failed sign-in message on the landing", async () => {
    vi.mocked(useLandingJourney).mockReturnValue(journey("GitHub sign-in was cancelled."));
    await open("", { signin_layout: "today" });

    expect(container.querySelector("#import")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("GitHub sign-in was cancelled.");
    await act(async () => button("or paste a public URL").click());
    expect(container.querySelector("#import-url")).not.toBeNull();
  });
});
