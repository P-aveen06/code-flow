// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { startSignIn } from "../../../pages/SignInImport";
import type { ImportStatus, Me } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { AppFlowTestProvider } from "../../AppFlowProvider";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { TODAY_PIECES } from "../../types";
import type { AppFlowState } from "../../types";
import { LandingSharedContext, SignInPanelB } from "./SignIn";
import type { LandingShared } from "./SignIn";

vi.mock("../../hooks/useMe", () => ({ useMe: vi.fn() }));
vi.mock("../../hooks/useUrlImport", () => ({ useUrlImport: vi.fn() }));
vi.mock("../../hooks/useLandingRepos", () => ({ useLandingRepos: vi.fn(), announceReposChanged: vi.fn() }));
vi.mock("../../../pages/SignInImport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../pages/SignInImport")>()),
  startSignIn: vi.fn(),
}));

const signedOut: Me = { configured: true, signed_in: false };
const signedIn: Me = {
  configured: true, signed_in: true, login: "octo", avatar_url: "", install_url: "https://github.com/apps/code-flow/installations/new",
};

let root: Root;
let container: HTMLDivElement;
let signOut: Mock<() => Promise<void>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(useMe).mockClear();
  vi.mocked(startSignIn).mockClear();
  signOut = vi.fn<() => Promise<void>>(async () => {});
  vi.mocked(useMe).mockReturnValue(account({ status: "ready", data: signedOut }));
  vi.mocked(useUrlImport).mockReturnValue(urlImport());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

// The panel as flow B's app flow has it: sign-in piece "b", so a failed sign-in comes back to it.
function appFlow(): AppFlowState {
  return {
    ready: true,
    reviewerId: "",
    flow: "b",
    pieces: { ...TODAY_PIECES, signin_layout: "b" },
    exposed: false,
    preview: false,
  };
}

async function render(placement: "hero" | "section" = "hero") {
  await act(async () => root.render(
    <AppFlowTestProvider value={appFlow()}>
      <SignInPanelB placement={placement} />
    </AppFlowTestProvider>,
  ));
}

function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

function tab(text: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((item) => item.textContent === text);
  if (!found) throw new Error(`No tab "${text}"`);
  return found;
}

// Types into a controlled input the way a visitor does, so React sees the change.
function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("flow B sign-in panel", () => {
  it("offers GitHub sign-in and the public URL option when signed out", async () => {
    await render();

    const panel = container.querySelector<HTMLElement>("#signin-panel");
    expect(panel?.tabIndex).toBe(-1);
    expect(panel?.querySelector("h2")?.textContent).toBe("Analyze a repo from your GitHub");
    expect(container.textContent).toContain("Sign in to pick any repo you allow, including private ones.");
    expect(container.querySelector("#signin-panel a.btn--primary")?.textContent).toBe("Sign in with GitHub");
    expect([...container.querySelectorAll("[role=tab]")].map((item) => item.textContent)).toEqual(["GitHub", "Public URL"]);
    expect(button("or paste a public URL")).toBeDefined();
  });

  it("sends the GitHub sign-in link through startSignIn, which records the round trip", async () => {
    await render();
    container.addEventListener("click", (event) => event.preventDefault());

    const signIn = container.querySelector<HTMLAnchorElement>("#signin-panel a.btn--primary");
    expect(signIn?.getAttribute("href")).toMatch(/\/api\/auth\/github\/login$/);
    await act(async () => signIn?.click());
    expect(startSignIn).toHaveBeenCalledOnce();
  });

  it("says the sign-in is being checked while GET /api/me is in flight", async () => {
    vi.mocked(useMe).mockReturnValue(account({ status: "loading" }));
    await render();

    expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking your GitHub sign-in…");
    expect(container.querySelector("#signin-panel a.btn--primary")?.textContent).toBe("Continue with GitHub");
  });

  it("shows the account, Choose a repository and sign out when signed in", async () => {
    vi.mocked(useMe).mockReturnValue(account({ status: "ready", data: signedIn }));
    await render();

    expect(container.querySelector(".fb-signin__account")?.textContent).toContain("Signed in as @octo");
    const choose = [...container.querySelectorAll<HTMLAnchorElement>("#signin-panel a")]
      .find((item) => item.textContent === "Choose a repository");
    expect(choose?.getAttribute("href")).toBe("/github");
    await act(async () => button("Sign out").click());
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("opens on the public URL form, with a notice, when the server has no GitHub sign-in", async () => {
    vi.mocked(useMe).mockReturnValue(account({ status: "ready", data: { configured: false, signed_in: false } }));
    await render();

    expect(tab("Public URL").getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("GitHub sign-in is not set up on this server yet.");
    expect(container.querySelector("#import-url")).not.toBeNull();

    await act(async () => tab("GitHub").click());
    expect(container.textContent).toContain("GitHub sign-in is not set up on this server yet.");
    expect(container.querySelector("#signin-panel a[href$='/api/auth/github/login']")).toBeNull();
    await act(async () => button("Paste a public URL").click());
    expect(container.querySelector("#import-url")).not.toBeNull();
  });

  it("shows a failed sign-in above the title", async () => {
    window.history.replaceState(null, "", "/?signin_error=expired");
    await render();

    expect(container.querySelector("#signin-panel [role=alert]")?.textContent)
      .toBe("The sign-in took too long or started in another tab. Try again.");
  });

  it("submits the public URL through the URL import hook", async () => {
    const url = urlImport();
    vi.mocked(useUrlImport).mockReturnValue(url);
    await render();

    await act(async () => tab("Public URL").click());
    const input = container.querySelector<HTMLInputElement>("#import-url");
    expect(input?.placeholder).toBe("https://github.com/Flagsmith/flagsmith");
    await act(async () => type(input!, "https://github.com/Flagsmith/flagsmith"));
    expect(url.edit).toHaveBeenCalledWith("url", "https://github.com/Flagsmith/flagsmith");

    await act(async () => container.querySelector<HTMLFormElement>("#signin-panel form")?.requestSubmit());
    expect(url.submit).toHaveBeenCalledOnce();
  });

  it("shows the import's error next to the form", async () => {
    vi.mocked(useUrlImport).mockReturnValue(urlImport({
      formError: { field: "url", message: "Enter a public GitHub repository URL like https://github.com/owner/repo." },
    }));
    await render();

    await act(async () => tab("Public URL").click());
    expect(container.querySelector("#signin-panel [role=alert]")?.textContent)
      .toBe("Enter a public GitHub repository URL like https://github.com/owner/repo.");
    expect(container.querySelector("#import-url")?.getAttribute("aria-describedby")).toBe("import-error");
  });

  it("shows the progress of the import it started", async () => {
    const update: ImportStatus = {
      id: "p_1", status: "analyzing", name: "octo/app", message: "", current: 5, total: 20, warning: null,
      error: null, new_commits: null, seconds: 2.5,
    };
    vi.mocked(useUrlImport).mockReturnValue(urlImport({
      job: { id: "p_1", status: "analyzing", body: { url: "https://github.com/octo/app", subdir: "", max_commits: 20 } },
      update,
      busy: true,
    }));
    await render();

    await act(async () => tab("Public URL").click());
    expect(container.querySelector('[role="status"][aria-label="Import progress"]')?.textContent).toContain("Analyzing commit 5 of 20");
    expect(container.textContent).toContain("Elapsed time 2.5 seconds");
    expect(container.querySelector<HTMLFormElement>("#signin-panel fieldset")?.disabled).toBe(true);
  });

  it("uses the landing's account and URL form when the landing provides them", async () => {
    const shared: LandingShared = { account: { me: { status: "ready", data: signedIn }, signOut }, url: urlImport() };
    await act(async () => root.render(
      <LandingSharedContext.Provider value={shared}>
        <SignInPanelB placement="section" />
      </LandingSharedContext.Provider>,
    ));

    expect(container.textContent).toContain("Signed in as @octo");
    expect(container.querySelector("#signin-panel")?.classList.contains("fb-signin__panel--section")).toBe(true);
    expect(useMe).not.toHaveBeenCalled();
  });
});
