// @vitest-environment happy-dom

import flagsmith from "@flagsmith/flagsmith";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFlowDirection, useCodeFlowFlags } from "./flags";

let root: Root;
let container: HTMLDivElement;

function Probe() {
  const flags = useCodeFlowFlags("?reviewer=demo");
  const { direction } = readFlowDirection(null, true, flags.directionFlag);
  return <p>{[flags.flowView, direction, flags.syncMode, flags.ready ? "ready" : "loading"].join(" ")}</p>;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Flagsmith connection", () => {
  it.each([
    ["", "demo"], ["https://flags.test/api/v1/", ""], ["   ", "   "],
  ])("skips SDK initialization when the URL or client key is blank", async (url, key) => {
    vi.stubEnv("VITE_FLAGSMITH_API_URL", url);
    vi.stubEnv("VITE_CODEFLOW_FLAGSMITH_ENV_KEY", key);
    const init = vi.spyOn(flagsmith, "init");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await act(async () => root.render(<Probe />));

    expect(container.textContent).toBe("overlay_summary vertical manual_button ready");
    expect(init).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders the fallbacks immediately and aborts a stalled flag request after 2.5 seconds", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_FLAGSMITH_API_URL", "https://flags.test/api/v1/");
    vi.stubEnv("VITE_CODEFLOW_FLAGSMITH_ENV_KEY", "demo");
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), delay);
      return controller.signal;
    });
    const fetch = vi.fn((_url: string, { signal }: RequestInit) => new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);

    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe("overlay_summary vertical manual_button loading");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://flags.test/api/v1/identities/?identifier=demo");

    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(container.textContent).toBe("overlay_summary vertical manual_button ready");
  });
});
