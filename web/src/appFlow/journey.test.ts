// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAppFlowJourney, forwardJourneyEvent, installJourneyTracking, markBranchSwitchOpened,
  markJourneyEventSent, readJourney, recordClick, recordDiagramMove, recordFlowViewOpened,
  recordReviewAnswer,
} from "./journey";

// Calls that reach the default Flagsmith client, which journey.ts uses when no client is passed.
const flagsmith = vi.hoisted(() => ({ trackEvent: vi.fn(), flushEvents: vi.fn(() => Promise.resolve()) }));
vi.mock("@flagsmith/flagsmith", () => ({ default: flagsmith }));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

// Puts the markup on the page and returns the element with id "target".
function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.getElementById("target") as HTMLElement;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  sessionStorage.clear();
  flagsmith.trackEvent.mockClear();
  flagsmith.flushEvents.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("beginAppFlowJourney", () => {
  it("keeps the journey of the same visitor and flow, and turns exposure on once it is true", () => {
    const store = memoryStorage();
    beginAppFlowJourney("reviewer-1", "a", false, 1_000, store);
    beginAppFlowJourney("reviewer-1", "a", true, 9_000, store);
    beginAppFlowJourney("reviewer-1", "a", false, 20_000, store);

    expect(readJourney(store)).toMatchObject({ reviewerId: "reviewer-1", flow: "a", exposed: true, landedAt: 1_000 });
  });

  it("starts a fresh journey for another visitor or flow", () => {
    const store = memoryStorage();
    beginAppFlowJourney("reviewer-1", "a", true, 1_000, store);
    recordDiagramMove(store);
    beginAppFlowJourney("reviewer-2", "a", true, 5_000, store);
    expect(readJourney(store)).toMatchObject({ reviewerId: "reviewer-2", landedAt: 5_000, diagramMoves: 0, sent: [] });

    beginAppFlowJourney("reviewer-2", "b", false, 7_000, store);
    expect(readJourney(store)).toMatchObject({ flow: "b", exposed: false, landedAt: 7_000 });
  });
});

describe("sending", () => {
  it("sends nothing for visitors outside the experiment", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", false, 0, store);
    forwardJourneyEvent("repo_selected", undefined, client, store);
    recordFlowViewOpened("owner__app", 10, client, store);
    recordReviewAnswer("diff_understood", 100, "owner__app", client, store);

    expect(client.trackEvent).not.toHaveBeenCalled();
  });

  it("sends each event once per journey, with the reviewer, flow and value", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    forwardJourneyEvent("import_completed", 30_000, client, store);
    forwardJourneyEvent("import_completed", 31_000, client, store);

    expect(client.trackEvent).toHaveBeenCalledExactlyOnceWith("import_completed", {
      identifier: "reviewer-1", value: 30_000, metadata: { flow: "a" },
    });
  });
});

describe("clicks", () => {
  const responding: Array<[string, string]> = [
    ["a button", '<button type="button"><span id="target">Save</span></button>'],
    ["a link", '<a href="#diagram"><span id="target">Docs</span></a>'],
    ["a tab", '<div role="tab" id="target">Overview</div>'],
    ["a menu item", '<div role="menuitem" id="target">Export</div>'],
    ["a focusable element", '<div tabindex="0" id="target">Item</div>'],
    ["the React Flow pane", '<div class="react-flow"><div class="react-flow__pane" id="target"></div></div>'],
    ["a label", '<label id="target">Name</label>'],
  ];

  it.each(responding)("does not count a click on %s as dead", (_name, html) => {
    const store = memoryStorage();
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    recordClick(render(html), store);

    expect(readJourney(store)).toMatchObject({ clicks: 1, deadClicks: 0 });
  });

  it("counts a click on plain content as dead", () => {
    const store = memoryStorage();
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    recordClick(render('<div id="target"><p>Some text</p></div>'), store);

    expect(readJourney(store)).toMatchObject({ clicks: 1, deadClicks: 1 });
  });

  it("does not count a click on selected text as dead", () => {
    const store = memoryStorage();
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    const text = render('<div id="target">Some text</div>');
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    recordClick(text, store);

    expect(readJourney(store)).toMatchObject({ clicks: 1, deadClicks: 0 });
  });

  it("ignores clicks when there is no journey", () => {
    const store = memoryStorage();
    recordClick(render('<div id="target"></div>'), store);

    expect(readJourney(store)).toBeNull();
  });
});

describe("diagram moves", () => {
  it("sends the moves once, with the first answer, counting from the flow view it was given on", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    recordFlowViewOpened("owner__app", 100, client, store);
    recordDiagramMove(store);
    recordDiagramMove(store);
    recordReviewAnswer("diff_confusing", 500, "owner__app", client, store);
    recordFlowViewOpened("owner__other", 900, client, store);
    recordDiagramMove(store);
    recordReviewAnswer("diff_understood", 300, "owner__other", client, store);

    expect(client.trackEvent.mock.calls).toEqual([
      ["diff_confusing", { identifier: "reviewer-1", value: 500, metadata: { flow: "a" } }],
      ["diagram_moves", { identifier: "reviewer-1", value: 2, metadata: { flow: "a" } }],
      ["diff_understood", { identifier: "reviewer-1", value: 300, metadata: { flow: "a" } }],
    ]);
  });
});

describe("leaving the page", () => {
  it("does not send dead clicks while leaving for GitHub", () => {
    sessionStorage.clear();
    flagsmith.trackEvent.mockClear();
    beginAppFlowJourney("reviewer-1", "a", true, 0);
    sessionStorage.setItem("code-flow:signin-journey", JSON.stringify({ redirecting: true }));
    const cleanup = installJourneyTracking();
    window.dispatchEvent(new Event("pagehide"));
    cleanup();
    expect(flagsmith.trackEvent).not.toHaveBeenCalledWith("dead_clicks", expect.anything());
    sessionStorage.clear();
  });
});

describe("completing the journey", () => {
  it("completes when another branch of the understood repo opens after an understood answer", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 1_000, store);
    recordFlowViewOpened("owner__app", 2_000, client, store);
    recordReviewAnswer("diff_understood", 800, "owner__app", client, store);
    markBranchSwitchOpened(5_000, store);
    recordClick(render('<button id="target">Go</button>'), store);
    recordClick(render('<button id="target">Go</button>'), store);
    recordClick(render('<div id="target">Nothing</div>'), store);
    recordFlowViewOpened("owner__app@feature~x", 9_000, client, store);

    expect(client.trackEvent.mock.calls).toEqual([
      ["diff_understood", { identifier: "reviewer-1", value: 800, metadata: { flow: "a" } }],
      ["diagram_moves", { identifier: "reviewer-1", value: 0, metadata: { flow: "a" } }],
      ["branch_switched", { identifier: "reviewer-1", value: 4_000, metadata: { flow: "a" } }],
      ["journey_completed", { identifier: "reviewer-1", value: 8_000, metadata: { flow: "a" } }],
      ["journey_clicks", { identifier: "reviewer-1", value: 3, metadata: { flow: "a" } }],
      ["dead_clicks", { identifier: "reviewer-1", value: 1, metadata: { flow: "a" } }],
    ]);
    expect(readJourney(store)).toMatchObject({ completed: true });
  });

  it("does not complete for another repo, the same branch, or without an understood answer", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    recordFlowViewOpened("owner__app", 1, client, store);
    recordReviewAnswer("diff_understood", 100, "owner__app", client, store);
    recordFlowViewOpened("owner__app", 2, client, store);
    recordFlowViewOpened("owner__tool@feature", 3, client, store);

    expect(client.trackEvent.mock.calls.map(([event]) => event)).toEqual(["diff_understood", "diagram_moves"]);
    expect(readJourney(store)).toMatchObject({ completed: false });
  });

  it("does not complete when the answer was confusing", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    recordFlowViewOpened("owner__app", 1, client, store);
    recordReviewAnswer("diff_confusing", 100, "owner__app", client, store);
    recordFlowViewOpened("owner__app@feature", 2, client, store);

    expect(client.trackEvent.mock.calls.map(([event]) => event)).toEqual(["diff_confusing", "diagram_moves"]);
  });

  it("sends branch_switched as 0 when the branch switch was never opened", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 1_000, store);
    recordFlowViewOpened("owner__app", 2_000, client, store);
    recordReviewAnswer("diff_understood", 100, "owner__app", client, store);
    recordFlowViewOpened("owner__app@feature", 9_000, client, store);

    expect(client.trackEvent).toHaveBeenCalledWith("branch_switched", {
      identifier: "reviewer-1", value: 0, metadata: { flow: "a" },
    });
  });

  it("completes once and stops counting clicks afterwards", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    recordFlowViewOpened("owner__app", 1, client, store);
    recordReviewAnswer("diff_understood", 100, "owner__app", client, store);
    recordFlowViewOpened("owner__app@feature", 2, client, store);
    recordClick(render('<div id="target">After</div>'), store);
    recordFlowViewOpened("owner__app@other", 3, client, store);

    expect(client.trackEvent.mock.calls.filter(([event]) => event === "journey_completed")).toHaveLength(1);
    expect(readJourney(store)).toMatchObject({ clicks: 0, completed: true });
  });

  it("keeps the first understood repo", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    recordReviewAnswer("diff_understood", 100, "owner__app", client, store);
    recordReviewAnswer("diff_understood", 200, "owner__other", client, store);

    expect(readJourney(store)).toMatchObject({ understoodRepo: "owner__app" });
  });
});

describe("events the other paths already sent", () => {
  it("does not forward a signin event that github_signin already sent", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    markJourneyEventSent("signin_completed", store);
    forwardJourneyEvent("signin_completed", undefined, client, store);

    expect(client.trackEvent).not.toHaveBeenCalled();
  });

  it("sends only the moves when the flow_view path already sent the outcome", () => {
    const store = memoryStorage();
    const client = { trackEvent: vi.fn() };
    beginAppFlowJourney("reviewer-1", "a", true, 0, store);
    markJourneyEventSent("diff_understood", store);
    recordReviewAnswer("diff_understood", 100, "owner__app", client, store);

    expect(client.trackEvent.mock.calls.map(([event]) => event)).toEqual(["diagram_moves"]);
  });
});

describe("installJourneyTracking", () => {
  let stopTracking: (() => void) | null = null;

  afterEach(() => {
    stopTracking?.();
    stopTracking = null;
  });

  it("counts each click on the page once, however often it is installed", () => {
    stopTracking = installJourneyTracking();
    installJourneyTracking();
    beginAppFlowJourney("reviewer-1", "a", true, 0);
    render('<div id="target">Some text</div>').dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(readJourney()).toMatchObject({ clicks: 1, deadClicks: 1 });
  });

  it("sends dead clicks once when the page is hidden, then flushes", () => {
    stopTracking = installJourneyTracking();
    beginAppFlowJourney("reviewer-1", "a", true, 0);
    render('<div id="target">Some text</div>').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));

    expect(flagsmith.trackEvent).toHaveBeenCalledExactlyOnceWith("dead_clicks", {
      identifier: "reviewer-1", value: 1, metadata: { flow: "a" },
    });
    expect(flagsmith.flushEvents).toHaveBeenCalled();
  });

  it("does not send dead clicks on pagehide once the journey has completed", () => {
    stopTracking = installJourneyTracking();
    beginAppFlowJourney("reviewer-1", "a", true, 0);
    recordFlowViewOpened("owner__app", 1);
    recordReviewAnswer("diff_understood", 100, "owner__app");
    recordFlowViewOpened("owner__app@feature", 2);
    flagsmith.trackEvent.mockClear();
    window.dispatchEvent(new Event("pagehide"));

    expect(flagsmith.trackEvent).not.toHaveBeenCalled();
  });
});
