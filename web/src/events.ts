import type { IFlagsmith } from "@flagsmith/flagsmith";
import type { FlowView } from "./view";

// Review ms is measured from the rendered diff to the decision.
// An empty base denotes the root commit.
export interface ReviewContext {
  view: FlowView;
  reviewerId: string;
  devOverride: boolean;
  repo: string;
  head: string;
  base: string;
}

export type ReviewOutcome = "diff_understood" | "diff_confusing";
export type ReviewEvent = ReviewContext & { event: ReviewOutcome; ms: number };
type DiffViewed = ReviewContext & { event: "diff_viewed" };
type DiffEvent = ReviewEvent | DiffViewed;

const events: DiffEvent[] = [];

export interface LayoutReview {
  client: Pick<IFlagsmith, "trackEvent">;
  exposed: boolean;
  override: string | null;
}

export function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function buildReviewEvent(
  context: ReviewContext,
  event: ReviewOutcome,
  start: number,
  end: number,
): ReviewEvent {
  return { ...context, event, ms: Math.round(end - start) };
}

function record(payload: DiffEvent) {
  events.push(payload);
  console.info(payload.event, payload);
}

export function recordReviewEvent(
  payload: ReviewEvent, client: Pick<IFlagsmith, "trackEvent"> | null, layout?: LayoutReview,
) {
  record(payload);
  if (!payload.devOverride && client) {
    client.trackEvent(payload.event, {
      identifier: payload.reviewerId,
      value: payload.ms,
      metadata: { variant: payload.view },
    });
  }
  if (layout?.exposed && layout.override === null) {
    const event = payload.event === "diff_understood" ? "layout_understood" : "layout_confusing";
    layout.client.trackEvent(event, { value: payload.ms });
  }
}

export function recordDiffViewed(context: ReviewContext) {
  // getExperimentFlag already records the Flagsmith exposure.
  record({ ...context, event: "diff_viewed" });
}

export function getReviewEvents(): readonly DiffEvent[] {
  return [...events];
}
