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
