// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { signInUrl } from "../../../api";
import { startSignIn } from "../../../pages/SignInImport";
import type { Me } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { openPublicUrlSheet, SignInModalC } from "./SignIn";

vi.mock("../../../pages/SignInImport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../pages/SignInImport")>()),
  startSignIn: vi.fn(),
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

let root: Root;
let container: HTMLDivElement;
let onClose: Mock<() => void>;
let signOut: Mock<() => Promise<void>>;
let submit: Mock<() => void>;
let retry: Mock<() => void>;

function showMe(me: RequestState<Me>) {
  vi.mocked(useMe).mockReturnValue({ me, refresh: vi.fn(), signOut });
}

function showImporter(overrides: Partial<ReturnType<typeof useUrlImport>> = {}) {
  vi.mocked(useUrlImport).mockReturnValue({
    fields: { url: "", subdir: "", maxCommits: "30" },
    edit: vi.fn(),
    formError: null,
    submit,
    busy: false,
    submitting: false,
    job: null,
    update: undefined,
    pollError: null,
    retry,
    ...overrides,
  });
}

async function renderSheet(open = true, error: string | null = null) {
  await act(async () => {
    root.render(<SignInModalC open={open} error={error} onClose={onClose} />);
  });
}

// The button or link with exactly this text.
function control(text: string): HTMLElement | null {
  return Array.from(container.querySelectorAll<HTMLElement>("button, a"))
    .find((element) => element.textContent?.trim() === text) ?? null;
}

function title(): string | undefined {
  return container.querySelector("h2")?.textContent ?? undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/");
  onClose = vi.fn<() => void>();
  signOut = vi.fn<() => Promise<void>>();
  submit = vi.fn<() => void>();
  retry = vi.fn<() => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  showMe({ status: "ready", data: signedOut });
  showImporter();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SignInModalC", () => {
  it("costs nothing while closed: no hooks run and nothing renders", async () => {
    await renderSheet(false);
    expect(container.innerHTML).toBe("");
    expect(useMe).not.toHaveBeenCalled();
  });

  it("signed out: the sign-in link goes to GitHub and runs startSignIn", async () => {
    await renderSheet();
    expect(title()).toBe("Analyze a repo from your GitHub");
    const link = control("Sign in with GitHub");
    expect(link?.getAttribute("href")).toBe(signInUrl());
    // The test does not follow the link to GitHub.
    link?.addEventListener("click", (event) => event.preventDefault());
    await act(async () => link?.click());
    expect(startSignIn).toHaveBeenCalledTimes(1);
  });

  it("paste a public URL switches the sheet to the URL form", async () => {
    await renderSheet();
    await act(async () => control("or paste a public URL")?.click());
    expect(title()).toBe("Analyze a public repository");
    expect(container.querySelector('label[for="import-url"]')?.textContent).toBe("Repository URL");
  });

  it("not set up: offers the public URL path", async () => {
    showMe({ status: "ready", data: { configured: false, signed_in: false } });
    await renderSheet();
    expect(container.textContent).toContain("GitHub sign-in is not set up on this server yet.");
    await act(async () => control("Paste a public URL")?.click());
    expect(title()).toBe("Analyze a public repository");
  });

  it("signed in: shows the account, Choose a repository to /github, and signs out", async () => {
    showMe({ status: "ready", data: signedIn });
    await renderSheet();
    expect(container.textContent).toContain("Signed in as @demo-user");
    expect(control("Choose a repository")?.getAttribute("href")).toBe("/github");
    await act(async () => control("Sign out")?.click());
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("while the session is checked, a status line says so", async () => {
    showMe({ status: "loading" });
    await renderSheet();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking your GitHub sign-in…");
  });

  it("a failed sign-in shows its message as an alert", async () => {
    await renderSheet(true, "GitHub sign-in was cancelled.");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("GitHub sign-in was cancelled.");
  });

  it("Escape and the close button both call onClose", async () => {
    await renderSheet();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("opens on the URL form when the landing asked for it, and not on the next open", async () => {
    openPublicUrlSheet(vi.fn());
    await renderSheet();
    expect(title()).toBe("Analyze a public repository");
    await act(async () => root.render(null));
    await renderSheet();
    expect(title()).toBe("Analyze a repo from your GitHub");
  });

  it("the URL form submits through the import hook", async () => {
    openPublicUrlSheet(vi.fn());
    await renderSheet();
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a failed import shows its message, and Try again retries it", async () => {
    showImporter({
      job: {
        id: "Flagsmith__flagsmith",
        status: "queued",
        body: { url: "https://github.com/Flagsmith/flagsmith", subdir: "", max_commits: 30 },
      },
      update: {
        id: "Flagsmith__flagsmith", status: "error", name: "", message: "", current: null, total: null,
        warning: null, error: "Could not clone the repository.", new_commits: null, seconds: 3.2,
      },
    });
    openPublicUrlSheet(vi.fn());
    await renderSheet();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not clone the repository.");
    await act(async () => control("Try again")?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("an analysis shows its step and its commit progress", async () => {
    showImporter({
      job: {
        id: "Flagsmith__flagsmith",
        status: "analyzing",
        body: { url: "https://github.com/Flagsmith/flagsmith", subdir: "", max_commits: 30 },
      },
      update: {
        id: "Flagsmith__flagsmith", status: "analyzing", name: "", message: "", current: 12, total: 20,
        warning: null, error: null, new_commits: null, seconds: 7.4,
      },
    });
    openPublicUrlSheet(vi.fn());
    await renderSheet();
    expect(container.textContent).toContain("Analyzing commit 12 of 20");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("Analyzing");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("12");
  });
});
