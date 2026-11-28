// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginJourney, markRedirecting, readJourney, resumeJourney, shouldReportAbandon, trackSignin,
} from "./signinEvents";
import { beginAppFlowJourney, readJourney as readAppFlowJourney } from "./appFlow/journey";

// Events that the github_signin client does not send reach Flagsmith through the default client.
const flagsmith = vi.hoisted(() => ({ trackEvent: vi.fn(), flushEvents: vi.fn(() => Promise.resolve()) }));
vi.mock("@flagsmith/flagsmith", () => ({ default: flagsmith }));

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

describe("returning to the repos page", () => {
  it("clears the GitHub redirect so leaving later counts as abandoning", () => {
    const store = memoryStorage();
    vi.spyOn(console, "info").mockImplementation(() => {});
    beginJourney("reviewer-4", "github_signin", true, 0, store);
    trackSignin("import_started", { trackEvent: vi.fn() }, 1, store);
    markRedirecting(store);
    resumeJourney(store);
    expect(readJourney(store)).toMatchObject({ redirecting: false, sent: ["import_started"] });
    expect(shouldReportAbandon(readJourney(store))).toBe(true);
  });

  it("does nothing without a journey", () => {
    const store = memoryStorage();
    resumeJourney(store);
    expect(readJourney(store)).toBeNull();
  });
});

describe("app_flow copies of the github_signin events", () => {
  beforeEach(() => {
    sessionStorage.clear();
    flagsmith.trackEvent.mockClear();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("sends the event for app_flow when github_signin is not sending it", () => {
    const store = memoryStorage();
    beginJourney("reviewer-5", "github_signin", false, 0, store);
    beginAppFlowJourney("reviewer-5", "a", true, 0);
    trackSignin("import_started", { trackEvent: vi.fn() }, 1, store);

    expect(flagsmith.trackEvent).toHaveBeenCalledExactlyOnceWith("import_started", {
      identifier: "reviewer-5", metadata: { flow: "a" },
    });
  });

  it("forwards timed events with the time since the github_signin landing", () => {
    const store = memoryStorage();
    beginJourney("reviewer-5", "github_signin", false, 1_000, store);
    beginAppFlowJourney("reviewer-5", "a", true, 2_000);
    trackSignin("import_completed", { trackEvent: vi.fn() }, 31_000, store);

    expect(flagsmith.trackEvent).toHaveBeenCalledExactlyOnceWith("import_completed", {
      identifier: "reviewer-5", value: 30_000, metadata: { flow: "a" },
    });
  });

  it("does not send the event again for app_flow when github_signin already sent it", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginJourney("reviewer-6", "github_signin", true, 0, store);
    beginAppFlowJourney("reviewer-6", "a", true, 0);
    trackSignin("import_started", client, 1, store);

    expect(client.trackEvent).toHaveBeenCalledTimes(1);
    expect(flagsmith.trackEvent).not.toHaveBeenCalled();
    expect(readAppFlowJourney()?.sent).toEqual(["import_started"]);
  });
});
