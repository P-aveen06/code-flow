// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Repo } from "../types";

vi.mock("../config", () => ({ apiUrl: "https://flow.test" }));

const demo: Repo = {
  id: "Flagsmith__flagsmith", name: "Flagsmith/flagsmith", url: "https://github.com/Flagsmith/flagsmith",
  subdir: "api", branch: "main", commit_count: 50, status: "ready", message: "Ready", warning: null,
};

let root: Root;
let container: HTMLDivElement;
const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_HOSTED_DEMO", "");
  vi.stubEnv("VITE_FLAGSMITH_API_URL", "");
  vi.stubEnv("VITE_CODEFLOW_FLAGSMITH_ENV_KEY", "");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset().mockImplementation(async () => Response.json([demo]));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function open(search = "") {
  window.history.replaceState(null, "", `/${search}`);
  await act(async () => root.render(<App />));
}

describe("landing previews", () => {
  function connectFlagsmith(response: () => Promise<Response>) {
    vi.stubEnv("VITE_FLAGSMITH_API_URL", "https://flags.test/api/v1/");
    vi.stubEnv("VITE_CODEFLOW_FLAGSMITH_ENV_KEY", "demo");
    mockFetch.mockImplementation(async (url) => String(url).startsWith("https://flags.test/")
      ? response() : Response.json([demo]));
  }

  function flag(enabled: boolean) {
    return { enabled, feature_state_value: null, feature: { id: 1, name: "variant_preview" } };
  }

  it.each(["a", "b", "c"])("offers the shared import form and demo link in local preview %s", async (variant) => {
    vi.stubEnv("DEV", true);
    await open(`?landing=${variant}`);

    const preview = container.querySelector(`.landing-preview--${variant}`);
    expect(preview?.querySelector('label[for="import-url"]')?.textContent).toBe("GitHub repository URL");
    expect(preview?.querySelector('label[for="import-subdir"]')).not.toBeNull();
    expect(preview?.querySelector('label[for="import-maxCommits"]')).not.toBeNull();
    const demoLink = preview?.querySelector(".landing-preview__actions a, .import-examples a");
    expect(demoLink?.getAttribute("href")).toBe("/repo/Flagsmith__flagsmith");

    await act(async () => preview?.querySelector<HTMLFormElement>("form")?.requestSubmit());
    expect(preview?.querySelector('[role="alert"]')?.textContent).toContain("Enter a public GitHub repository URL");
    expect(document.activeElement?.id).toBe("import-url");
  });

  it.each(["", "?landing=unknown"])("keeps the default in development without a valid override (%s)", async (search) => {
    vi.stubEnv("DEV", true);
    await open(search);
    expect(container.querySelector("main.landing")).not.toBeNull();
  });

  it("keeps the production default with no Flagsmith connection", async () => {
    await open("?landing=a");
    expect(container.querySelector("main.landing")).not.toBeNull();
    expect(container.querySelector("main.landing-preview")).toBeNull();
  });

  it.each(["enabled", "disabled", "missing", "unavailable"])(
    "gates the production override when variant_preview is %s", async (state) => {
      connectFlagsmith(async () => state === "unavailable"
        ? Response.json({}, { status: 503 })
        : Response.json({ flags: state === "missing" ? [] : [flag(state === "enabled")] }));
      await open("?landing=b&reviewer=landing-test");

      expect(mockFetch).toHaveBeenCalledWith("https://flags.test/api/v1/identities/?identifier=landing-test", expect.anything());
      expect(Boolean(container.querySelector("main.landing-preview--b"))).toBe(state === "enabled");
      expect(Boolean(container.querySelector("main.landing"))).toBe(state !== "enabled");
    },
  );

  it("keeps the default and skips the flag request without a query override", async () => {
    connectFlagsmith(async () => Response.json({ flags: [flag(true)] }));
    await open();
    expect(container.querySelector("main.landing")).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["a", "b", "c"])("shows and clears the startup status and skeleton in preview %s", async (variant) => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_HOSTED_DEMO", "1");
    mockFetch.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    await open(`?landing=${variant}`);

    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading repositories…");
    expect(container.querySelector('.repo-list[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector("progress")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Waking up the demo server (about 30 s)…");
    expect(container.querySelector('progress[aria-label="Demo server startup"]')?.hasAttribute("value")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(container.querySelector('.repo-list[aria-hidden="true"]')).toBeNull();
    expect(container.querySelector("progress")).toBeNull();
    expect(container.querySelector('a[aria-label="Open Flagsmith/flagsmith"]')).not.toBeNull();
  });
});

describe("hosted landing", () => {
  it("shows the wake-up message after three seconds and clears it when the list arrives", async () => {
    vi.stubEnv("VITE_HOSTED_DEMO", "1");
    let finish!: (response: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await open();

    expect(container.textContent).toContain("Loading repositories…");
    expect(container.textContent).toContain("Imports and new commits on this demo are temporary");
    const examples = container.querySelectorAll(".import-examples__actions > *");
    expect(examples).toHaveLength(1);
    expect(examples[0].getAttribute("href")).toBe("/repo/Flagsmith__flagsmith");
    expect(examples[0].textContent).toContain("Flagsmith/flagsmith (api/)");
    await act(async () => vi.advanceTimersByTimeAsync(2999));
    expect(container.textContent).not.toContain("Waking up the demo server…");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Waking up the demo server…");
    await act(async () => finish(Response.json([demo])));
    expect(container.textContent).not.toContain("Waking up the demo server…");
    expect(container.querySelector('a[aria-label="Open Flagsmith/flagsmith"]')).not.toBeNull();
  });

  it("retries network and server failures with backoff", async () => {
    vi.stubEnv("VITE_HOSTED_DEMO", "1");
    mockFetch.mockRejectedValueOnce(new Error("offline"));
    mockFetch.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await open();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Waking up the demo server…");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(container.querySelector('a[aria-label="Open Flagsmith/flagsmith"]')).not.toBeNull();
  });

  it("keeps the notice off by default", async () => {
    await open();
    expect(container.textContent).not.toContain("Imports and new commits on this demo are temporary");
  });
});
