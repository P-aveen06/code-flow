import { describe, expect, it, vi } from "vitest";
import {
  buildReviewEvent, formatElapsed, getReviewEvents, recordDiffViewed, recordReviewEvent,
} from "./events";
import type { ReviewContext } from "./events";
import { readPreviewOverrides } from "./view";

const context: ReviewContext = {
  repo: "shop-demo",
  head: "abc123",
  base: "",
  view: "overlay_summary",
  reviewerId: "demo-1",
  devOverride: true,
};

describe("review timing", () => {
  it("formats elapsed milliseconds as seconds to one decimal place", () => {
    expect(formatElapsed(0)).toBe("0.0 s");
    expect(formatElapsed(12300)).toBe("12.3 s");
    expect(formatElapsed(1250)).toBe("1.3 s");
  });

  it("builds a flat review payload with elapsed milliseconds", () => {
    expect(buildReviewEvent(context, "diff_understood", 100.1, 12400.2)).toEqual({
      event: "diff_understood",
      ms: 12300,
      view: "overlay_summary",
      reviewerId: "demo-1",
      devOverride: true,
      repo: "shop-demo",
      head: "abc123",
      base: "",
    });
  });
});

it("records the view and review in memory and logs both", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const review = buildReviewEvent(context, "diff_confusing", 100, 450);
  const viewed = { ...context, event: "diff_viewed" };
  const start = getReviewEvents().length;

  try {
    recordDiffViewed(context);
    recordReviewEvent(review, null);
    expect(getReviewEvents().slice(start)).toEqual([viewed, review]);
    expect(log).toHaveBeenCalledWith("diff_viewed", viewed);
    expect(log).toHaveBeenCalledWith("diff_confusing", review);
  } finally {
    log.mockRestore();
  }
});

describe("Flagsmith review events", () => {
  const assignedContext = { ...context, devOverride: false };

  it.each(["diff_understood", "diff_confusing"] as const)("sends %s with the review time and variant", (outcome) => {
    const client = { trackEvent: vi.fn() };
    const review = buildReviewEvent(assignedContext, outcome, 100, 450);

    recordReviewEvent(review, client);

    expect(client.trackEvent).toHaveBeenCalledExactlyOnceWith(outcome, {
      identifier: assignedContext.reviewerId,
      value: 350,
      metadata: { variant: "overlay_summary" },
    });
  });

  it.each(["diff_understood", "diff_confusing"] as const)("keeps preview %s local even with a working client", (outcome) => {
    const client = { trackEvent: vi.fn() };
    const review = buildReviewEvent(context, outcome, 100, 450);

    recordReviewEvent(review, client);

    expect(client.trackEvent).not.toHaveBeenCalled();
    expect(getReviewEvents().at(-1)).toEqual(review);
  });

  it("keeps a review local when Flagsmith is unavailable", () => {
    const review = buildReviewEvent(assignedContext, "diff_confusing", 100, 450);

    recordReviewEvent(review, null);

    expect(getReviewEvents().at(-1)).toEqual(review);
  });
});

describe("layout review events", () => {
  it.each([
    ["diff_understood", "layout_understood"],
    ["diff_confusing", "layout_confusing"],
  ] as const)("sends %s and %s with the same review time", (outcome, layoutOutcome) => {
    const client = { trackEvent: vi.fn() };
    const review = buildReviewEvent({ ...context, devOverride: false }, outcome, 100, 450);
    recordReviewEvent(review, client, { client, exposed: true });

    expect(client.trackEvent).toHaveBeenNthCalledWith(1, outcome, {
      identifier: "demo-1", value: 350, metadata: { variant: "overlay_summary" },
    });
    expect(client.trackEvent).toHaveBeenNthCalledWith(2, layoutOutcome, { value: 350 });
  });

  it.each(["?view=overlay", "?direction=horizontal"])("keeps both experiments local during %s", (search) => {
    const client = { trackEvent: vi.fn() };
    const { viewOverride, directionOverride } = readPreviewOverrides(search, true);
    const review = buildReviewEvent({ ...context, devOverride: (viewOverride ?? directionOverride) !== null },
      "diff_understood", 100, 450);
    recordReviewEvent(review, client, { client, exposed: true });

    expect(client.trackEvent).not.toHaveBeenCalled();
  });

  it("keeps the view review when the layout is excluded", () => {
    const client = { trackEvent: vi.fn() };
    const review = buildReviewEvent({ ...context, devOverride: false }, "diff_confusing", 100, 450);
    recordReviewEvent(review, client, { client, exposed: false });

    expect(client.trackEvent).toHaveBeenCalledExactlyOnceWith("diff_confusing", {
      identifier: "demo-1", value: 350, metadata: { variant: "overlay_summary" },
    });
  });

  it("sends both exposed outcomes when URL overrides are ignored", () => {
    const client = { trackEvent: vi.fn() };
    const { viewOverride, directionOverride } = readPreviewOverrides("?view=overlay&direction=horizontal", false);
    const review = buildReviewEvent({ ...context, devOverride: (viewOverride ?? directionOverride) !== null },
      "diff_understood", 100, 450);
    recordReviewEvent(review, client, { client, exposed: true });

    expect(client.trackEvent.mock.calls.map(([event]) => event)).toEqual(["diff_understood", "layout_understood"]);
  });
});
