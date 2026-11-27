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
  vi.stubEnv("VITE_HOSTED_DEMO", "");
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

async function open() {
  window.history.replaceState(null, "", "/");
  await act(async () => root.render(<App />));
}

describe("landing", () => {
  it("offers the Flagsmith demo link and repository import form", async () => {
    await open();

    const demoLink = container.querySelector('a[href="/repo/Flagsmith__flagsmith"]');
    expect(demoLink?.textContent).toBe("Open the Flagsmith demo");
    expect(container.querySelector('a[href="#import"]')?.textContent).toBe("Analyze your own repo");
    const form = container.querySelector<HTMLFormElement>("#import form");
    expect(form?.querySelector('label[for="import-url"]')?.textContent).toBe("GitHub repository URL");
    expect(form?.querySelector('label[for="import-subdir"]')?.textContent).toBe("Subfolder (optional)");
    expect(form?.querySelector('label[for="import-maxCommits"]')?.textContent).toBe("Number of recent commits");

    await act(async () => form?.requestSubmit());
    expect(form?.querySelector('[role="alert"]')?.textContent).toContain("Enter a public GitHub repository URL");
    expect(document.activeElement?.id).toBe("import-url");
  });

  it("explains the Production rollout, code flag checks, and Development previews", async () => {
    await open();

    const strip = container.querySelector('section[aria-labelledby="flags-use-title"]');
    expect(strip?.querySelector("h2")?.textContent).toBe("How Flagsmith is used");
    const cards = Array.from(strip?.querySelectorAll("article") ?? [], (card) => card.textContent);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain("flow_view experiment");
    expect(cards[0]).toContain("Overlay + summary won with a 30.6% relative lift in understanding");
    expect(cards[0]).toContain("1,300 simulated reviewers. It rolled out in Production.");
    expect(cards[1]).toContain("Flagsmith and OpenFeature flag checks in the code and shows which calls they guard");
    expect(cards[2]).toContain("variant_preview");
    expect(cards[2]).toContain("Development only");
  });

  it("keeps the hosted-demo notice off by default", async () => {
    await open();
    expect(container.textContent).not.toContain("Imports and new commits on this demo are temporary");
  });
});

describe("hosted landing", () => {
  it("shows the startup progress after three seconds and clears it when the list arrives", async () => {
    vi.stubEnv("VITE_HOSTED_DEMO", "1");
    let finish!: (response: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await open();

    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading repositories…");
    expect(container.querySelector('.repo-list[aria-hidden="true"]')).not.toBeNull();
    expect(container.textContent).toContain("Imports and new commits on this demo are temporary");
    await act(async () => vi.advanceTimersByTimeAsync(2999));
    expect(container.querySelector("progress")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Waking up the demo server (about 30 s)…");
    expect(container.querySelector('progress[aria-label="Demo server startup"]')?.hasAttribute("value")).toBe(false);
    await act(async () => finish(Response.json([demo])));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector("progress")).toBeNull();
    expect(container.querySelector('.repo-list[aria-hidden="true"]')).toBeNull();
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
    expect(container.textContent).toContain("Waking up the demo server (about 30 s)…");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(container.querySelector('a[aria-label="Open Flagsmith/flagsmith"]')).not.toBeNull();
  });
});
