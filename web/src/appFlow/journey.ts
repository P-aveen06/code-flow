// STUB from the scaffold. Worker F4 implements these; keep every exported name and signature.
// Events for the app_flow experiment. See docs/APP_FLOW_BUILD.md, "Journey events".
import type { Flow } from "./types";

export type ReviewAnswer = "diff_understood" | "diff_confusing";

/** Landing page: start (or keep) this visitor's app_flow journey. */
export function beginAppFlowJourney(_reviewerId: string, _flow: Flow, _exposed: boolean, _now = Date.now()): void {}

/** Called by signinEvents.trackSignin so the existing journey events also reach Flagsmith for app_flow visitors. */
export function forwardJourneyEvent(_event: string, _value?: number): void {}

/** Every click on the page, from the listener installJourneyTracking adds. */
export function recordClick(_target: EventTarget | null): void {}

/** A user pan, zoom or node drag on the diagram. */
export function recordDiagramMove(): void {}

/** The review question was answered on the flow view of import `repoId`. */
export function recordReviewAnswer(_outcome: ReviewAnswer, _ms: number, _repoId: string): void {}

/** The branch switch UI was opened (any piece, including today's link). */
export function markBranchSwitchOpened(_now = Date.now()): void {}

/** The diagram (or the no-flow-change message) finished rendering on the flow view of import `repoId`. */
export function recordFlowViewOpened(_repoId: string, _now = Date.now()): void {}

/** Install the click listener and the pagehide handler once, from main.tsx. Returns a cleanup. */
export function installJourneyTracking(): () => void {
  return () => {};
}
