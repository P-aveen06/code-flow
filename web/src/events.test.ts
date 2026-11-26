import { describe, expect, it, vi } from "vitest";
import {
  buildReviewEvent, formatElapsed, getReviewEvents, recordDiffViewed, recordReviewEvent,
} from "./events";
import type { ReviewContext } from "./events";

const context: ReviewContext = {
  repo: "shop-demo",
  head: "abc123",
  base: "",
  view: "overlay_summary",
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
      repo: "shop-demo",
      head: "abc123",
      base: "",
    });
  });
});

it("records the exposure and review in memory and logs both", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const review = buildReviewEvent(context, "diff_confusing", 100, 450);
  const viewed = { ...context, event: "diff_viewed" };
  const start = getReviewEvents().length;

  try {
    recordDiffViewed(context);
    recordReviewEvent(review);
    expect(getReviewEvents().slice(start)).toEqual([viewed, review]);
    expect(log).toHaveBeenCalledWith("diff_viewed", viewed);
    expect(log).toHaveBeenCalledWith("diff_confusing", review);
  } finally {
    log.mockRestore();
  }
});
