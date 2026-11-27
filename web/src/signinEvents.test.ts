import { describe, expect, it, vi } from "vitest";
import {
  beginJourney, markRedirecting, readJourney, shouldReportAbandon, trackSignin,
} from "./signinEvents";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("github_signin journey events", () => {
  it("sends each event once, with time since landing on the timed ones", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    vi.spyOn(console, "info").mockImplementation(() => {});
    beginJourney("reviewer-1", "github_signin", true, 1_000, store);

    expect(trackSignin("first_flow_viewed", client, 2_000, store)).toBe(false);
    expect(trackSignin("import_started", client, 2_000, store)).toBe(true);
    expect(trackSignin("import_started", client, 3_000, store)).toBe(false);
    trackSignin("import_completed", client, 31_000, store);

    expect(client.trackEvent.mock.calls).toEqual([
      ["import_started", { identifier: "reviewer-1", metadata: { variant: "github_signin" } }],
      ["import_completed", { identifier: "reviewer-1", value: 30_000, metadata: { variant: "github_signin" } }],
    ]);
  });

  it("keeps visitors outside the experiment out of Flagsmith", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    vi.spyOn(console, "info").mockImplementation(() => {});
    beginJourney("reviewer-2", "url_import", false, 0, store);
    expect(trackSignin("import_started", client, 1, store)).toBe(true);
    expect(client.trackEvent).not.toHaveBeenCalled();
  });

  it("survives the GitHub round trip and does not count it as abandoning", () => {
    const store = memoryStorage();
    vi.spyOn(console, "info").mockImplementation(() => {});
    beginJourney("reviewer-3", "github_signin", true, 500, store);
    trackSignin("import_started", { trackEvent: vi.fn() }, 600, store);
    expect(shouldReportAbandon(readJourney(store))).toBe(true);
    markRedirecting(store);
    expect(shouldReportAbandon(readJourney(store))).toBe(false);

    // Back from GitHub: the same visitor and variant keep their clock and sent events.
    beginJourney("reviewer-3", "github_signin", true, 90_000, store);
    const journey = readJourney(store);
    expect(journey?.landedAt).toBe(500);
    expect(journey?.sent).toEqual(["import_started"]);
    expect(journey?.redirecting).toBe(false);
  });
});
