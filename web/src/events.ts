import type { FlowView } from "./view";

// M4 can send these flat payloads to Flagsmith. Review ms is measured from
// the rendered diff to the decision. An empty base denotes the root commit.
export interface ReviewContext {
  view: FlowView;
  repo: string;
  head: string;
  base: string;
}

export type ReviewOutcome = "diff_understood" | "diff_confusing";
export type ReviewEvent = ReviewContext & { event: ReviewOutcome; ms: number };
type DiffViewed = ReviewContext & { event: "diff_viewed" };
type DiffEvent = ReviewEvent | DiffViewed;

const events: DiffEvent[] = [];

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

export function recordReviewEvent(payload: ReviewEvent) {
  record(payload);
}

export function recordDiffViewed(context: ReviewContext) {
  record({ ...context, event: "diff_viewed" });
}

export function getReviewEvents(): readonly DiffEvent[] {
  return [...events];
}
