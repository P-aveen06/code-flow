// app_flow journey events: how a visitor gets from the landing page to a second branch of the
// same repo. Only visitors exposed to app_flow send them, never preview visitors. The journey
// lives in sessionStorage so it survives the GitHub round trip. See docs/APP_FLOW_BUILD.md,
// "Journey events".
import flagsmith from "@flagsmith/flagsmith";
import type { IFlagsmith } from "@flagsmith/flagsmith";
import type { Flow } from "./types";

export type ReviewAnswer = "diff_understood" | "diff_confusing";

const journeyKey = "code-flow:app-flow-journey";

// A click on one of these responds (it navigates, toggles, selects or starts something).
// Any other click is a dead click.
const respondingSelector = [
  "a", "button", "input", "select", "textarea", "label", "summary",
  "[role=button]", "[role=tab]", "[role=option]", "[role=menuitem]", "[tabindex]", ".react-flow",
].join(", ");

interface Journey {
  reviewerId: string;
  flow: Flow;
  exposed: boolean;
  landedAt: number;
  // Events already sent to Flagsmith for this visitor, by this journey or by the github_signin path.
  sent: string[];
  clicks: number;
  deadClicks: number;
  diagramMoves: number;
  understoodRepo: string | null;
  switchOpenedAt: number | null;
  completed: boolean;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Client = Pick<IFlagsmith, "trackEvent">;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readJourney(store: Storage | null = storage()): Journey | null {
  try {
    const value = store?.getItem(journeyKey);
    return value ? JSON.parse(value) as Journey : null;
  } catch {
    return null;
  }
}

function saveJourney(journey: Journey, store: Storage | null = storage()) {
  try {
    store?.setItem(journeyKey, JSON.stringify(journey));
  } catch {
    // Without storage the journey's later events are lost, nothing else.
  }
}

// Analytics must never break the page, so a failing Flagsmith call is ignored.
function sendEvent(journey: Journey, client: Client, event: string, value?: number) {
  console.info(event, { flow: journey.flow, value });
  try {
    client.trackEvent(event, {
      identifier: journey.reviewerId,
      ...(value === undefined ? {} : { value }),
      metadata: { flow: journey.flow },
    });
  } catch {
    // Flagsmith may be unreachable.
  }
}

// Each event name counts once per journey, and only exposed visitors send anything.
function sendOnce(journey: Journey, client: Client, event: string, value?: number): Journey {
  if (!journey.exposed || journey.sent.includes(event)) return journey;
  sendEvent(journey, client, event, value);
  return { ...journey, sent: [...journey.sent, event] };
}

/** Landing page: start (or keep) this visitor's app_flow journey. */
export function beginAppFlowJourney(
  reviewerId: string, flow: Flow, exposed: boolean, now = Date.now(), store = storage(),
): void {
  const journey = readJourney(store);
  if (journey && journey.reviewerId === reviewerId && journey.flow === flow) {
    saveJourney({ ...journey, exposed: journey.exposed || exposed }, store);
    return;
  }
  saveJourney({
    reviewerId, flow, exposed, landedAt: now, sent: [], clicks: 0, deadClicks: 0, diagramMoves: 0,
    understoodRepo: null, switchOpenedAt: null, completed: false,
  }, store);
}

/** Called by signinEvents.trackSignin so the existing journey events also reach Flagsmith for app_flow visitors. */
export function forwardJourneyEvent(
  event: string, value?: number, client: Client = flagsmith, store = storage(),
): void {
  const journey = readJourney(store);
  if (journey) saveJourney(sendOnce(journey, client, event, value), store);
}

/** The github_signin path already sent this event to Flagsmith for this visitor, so the journey must not send it again. */
export function markJourneyEventSent(event: string, store = storage()): void {
  const journey = readJourney(store);
  if (journey && !journey.sent.includes(event)) {
    saveJourney({ ...journey, sent: [...journey.sent, event] }, store);
  }
}

/** Every click on the page, from the listener installJourneyTracking adds. */
export function recordClick(target: EventTarget | null, store = storage()): void {
  const journey = readJourney(store);
  if (!journey || journey.completed) return;
  saveJourney({
    ...journey,
    clicks: journey.clicks + 1,
    deadClicks: journey.deadClicks + (isDeadClick(target) ? 1 : 0),
  }, store);
}

// A click is dead when nothing on its path responds to it and the visitor is not selecting text.
function isDeadClick(target: EventTarget | null): boolean {
  if (window.getSelection()?.toString()) return false;
  return !(target instanceof Element && target.closest(respondingSelector));
}

/** A user pan, zoom or node drag on the diagram. */
export function recordDiagramMove(store = storage()): void {
  const journey = readJourney(store);
  if (journey) saveJourney({ ...journey, diagramMoves: journey.diagramMoves + 1 }, store);
}

/** The review question was answered on the flow view of import `repoId`. */
export function recordReviewAnswer(
  outcome: ReviewAnswer, ms: number, repoId: string, client: Client = flagsmith, store = storage(),
): void {
  const journey = readJourney(store);
  if (!journey) return;
  // Moves go out once, with the first answer, like the answer events themselves.
  const afterOutcome = sendOnce(sendOnce(journey, client, outcome, ms), client, "diagram_moves", journey.diagramMoves);
  // The first understood answer decides which repo a later branch switch has to match.
  const understoodRepo = afterOutcome.understoodRepo ?? (outcome === "diff_understood" ? repoId : null);
  saveJourney({ ...afterOutcome, diagramMoves: 0, understoodRepo }, store);
}

/** The branch switch UI was opened (any piece, including today's link). */
export function markBranchSwitchOpened(now = Date.now(), store = storage()): void {
  const journey = readJourney(store);
  if (journey) saveJourney({ ...journey, switchOpenedAt: now }, store);
}

/** The diagram (or the no-flow-change message) finished rendering on the flow view of import `repoId`. */
export function recordFlowViewOpened(
  repoId: string, now = Date.now(), client: Client = flagsmith, store = storage(),
): void {
  const journey = readJourney(store);
  if (!journey) return;
  let next: Journey = { ...journey, diagramMoves: 0 };
  if (isOtherBranchOfUnderstoodRepo(next, repoId)) {
    const switchMs = next.switchOpenedAt === null ? 0 : Math.max(0, now - next.switchOpenedAt);
    next = sendOnce(next, client, "branch_switched", switchMs);
    next = sendOnce(next, client, "journey_completed", Math.max(0, now - next.landedAt));
    next = sendOnce(next, client, "journey_clicks", next.clicks);
    next = sendOnce(next, client, "dead_clicks", next.deadClicks);
    next = { ...next, completed: true };
  }
  saveJourney(next, store);
}

// Import ids look like "owner__name", "owner__name@branch" or "p_<uid>__owner__name@branch".
// Two imports are branches of one repo when their part before "@" matches.
function isOtherBranchOfUnderstoodRepo(journey: Journey, repoId: string): boolean {
  const understood = journey.understoodRepo;
  return understood !== null && !journey.completed && repoId !== understood
    && repoFamily(repoId) === repoFamily(understood);
}

function repoFamily(repoId: string): string {
  return repoId.split("@")[0];
}

// signinEvents.markRedirecting sets this flag on its own journey before a GitHub round trip.
function leavingForGitHub(store = storage()): boolean {
  try {
    const signin = store?.getItem("code-flow:signin-journey");
    return Boolean(signin && (JSON.parse(signin) as { redirecting?: boolean }).redirecting);
  } catch {
    return false;
  }
}

let removeListeners: (() => void) | null = null;

/** Install the click listener and the pagehide handler once, from main.tsx. Returns a cleanup. */
export function installJourneyTracking(): () => void {
  if (removeListeners) return removeListeners;
  const onClick = (event: MouseEvent) => recordClick(event.target);
  const onPageHide = () => {
    const journey = readJourney();
    // Leaving for GitHub's sign-in or install page is part of the journey, not the end of it.
    if (!journey || journey.completed || leavingForGitHub()) return;
    saveJourney(sendOnce(journey, flagsmith, "dead_clicks", journey.deadClicks));
    void flagsmith.flushEvents?.();
  };
  document.addEventListener("click", onClick, true);
  window.addEventListener("pagehide", onPageHide);
  const remove = () => {
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("pagehide", onPageHide);
    removeListeners = null;
  };
  removeListeners = remove;
  return remove;
}
