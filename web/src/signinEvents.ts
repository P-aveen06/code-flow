import flagsmith from "@flagsmith/flagsmith";
import type { IFlagsmith } from "@flagsmith/flagsmith";
import type { SigninVariant } from "./flags";
import { forwardJourneyEvent, markJourneyEventSent } from "./appFlow/journey";

// Events for the github_signin experiment. The journey lives in sessionStorage so it
// survives the round trip to GitHub, which reloads the page.
export type SigninEvent =
  | "import_started"
  | "signin_started"
  | "signin_completed"
  | "app_installed"
  | "repo_selected"
  | "import_completed"
  | "first_flow_viewed"
  | "import_abandoned";

// These events carry the milliseconds since the visitor first saw the landing page.
const timedEvents: ReadonlySet<SigninEvent> = new Set(["import_completed", "first_flow_viewed"]);
const journeyKey = "code-flow:signin-journey";

interface Journey {
  reviewerId: string;
  variant: SigninVariant;
  exposed: boolean;
  landedAt: number;
  sent: SigninEvent[];
  redirecting: boolean;
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
    // Without storage the experiment loses this visitor's later events, nothing else.
  }
}

// Start a journey on the landing page, or keep the one already running for this visitor.
export function beginJourney(
  reviewerId: string, variant: SigninVariant, exposed: boolean,
  now = Date.now(), store: Storage | null = storage(),
) {
  const journey = readJourney(store);
  if (journey && journey.reviewerId === reviewerId && journey.variant === variant) {
    saveJourney({ ...journey, exposed: journey.exposed || exposed, redirecting: false }, store);
    return;
  }
  saveJourney({ reviewerId, variant, exposed, landedAt: now, sent: [], redirecting: false }, store);
}

// Each event counts once per journey. Only visitors in the experiment reach Flagsmith from here.
export function trackSignin(
  event: SigninEvent, client: Client = flagsmith, now = Date.now(), store: Storage | null = storage(),
) {
  const journey = readJourney(store);
  if (!journey || journey.sent.includes(event)) return false;
  if (event === "first_flow_viewed" && !journey.sent.includes("import_started")) return false;
  const value = timedEvents.has(event) ? Math.max(0, now - journey.landedAt) : undefined;
  saveJourney({ ...journey, sent: [...journey.sent, event] }, store);
  console.info(event, { variant: journey.variant, value });
  let sentToFlagsmith = false;
  if (journey.exposed) {
    try {
      client.trackEvent(event, {
        identifier: journey.reviewerId,
        ...(value === undefined ? {} : { value }),
        metadata: { variant: journey.variant },
      });
      sentToFlagsmith = true;
    } catch {
      // Flagsmith may be unreachable; the import itself must not fail because of it.
    }
  }
  // The app_flow copy of the event goes to Flagsmith only when this path did not already send it.
  if (sentToFlagsmith) markJourneyEventSent(event);
  else forwardJourneyEvent(event, value);
  return true;
}

// Leaving for GitHub is part of sign-in, not an abandoned import.
export function markRedirecting(store: Storage | null = storage()) {
  const journey = readJourney(store);
  if (journey) saveJourney({ ...journey, redirecting: true }, store);
}

// Back from GitHub on a page other than the landing page, which calls beginJourney instead.
export function resumeJourney(store: Storage | null = storage()) {
  const journey = readJourney(store);
  if (journey?.redirecting) saveJourney({ ...journey, redirecting: false }, store);
}

export function shouldReportAbandon(journey: Journey | null) {
  return Boolean(journey && !journey.redirecting && journey.sent.includes("import_started")
    && !journey.sent.includes("import_completed"));
}

export function watchForAbandon(client: Pick<IFlagsmith, "trackEvent" | "flushEvents"> = flagsmith) {
  const onPageHide = () => {
    if (!shouldReportAbandon(readJourney())) return;
    trackSignin("import_abandoned", client);
    void client.flushEvents?.();
  };
  window.addEventListener("pagehide", onPageHide);
  return () => window.removeEventListener("pagehide", onPageHide);
}
