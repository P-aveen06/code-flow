import { useEffect, useState } from "react";
import { useSigninVariant } from "../../flags";
import type { SigninAssignment, SigninVariant } from "../../flags";
import { navigate, useLocation } from "../../router";
import { beginJourney, watchForAbandon } from "../../signinEvents";
import { useAppFlow } from "../AppFlowProvider";
import { beginAppFlowJourney } from "../journey";

// A failed sign-in returns to the landing with signin_error; the page reads it once, then drops it.
// A successful one goes to the repos page (/github).
const returnParams = ["signin_error"];
const signinErrors: Record<string, string> = {
  denied: "GitHub sign-in was cancelled.",
  expired: "The sign-in took too long or started in another tab. Try again.",
  github: "GitHub did not accept the sign-in. Try again.",
};

export function readSigninError(search: string) {
  const code = new URLSearchParams(search).get("signin_error") ?? "";
  // Own keys only: ?signin_error=constructor must not read Object.prototype.
  return Object.hasOwn(signinErrors, code) ? signinErrors[code] : null;
}

// Everything the landing does on arrival: the sign-in variant it offers, the error of a failed
// sign-in, and the journey events. Call this once per landing, since it reads the sign-in flag.
export function useLandingJourney(): { signinError: string | null; signin: SigninAssignment } {
  const { search } = useLocation();
  const appFlow = useAppFlow();
  const assigned = useSigninVariant(search);
  // The tested app_flow journey starts with sign-in, so its landing always offers it.
  const variant: SigninVariant = appFlow.flow !== null ? "github_signin" : assigned.variant;
  const signin: SigninAssignment = { ...assigned, variant };
  const [signinError] = useState(() => readSigninError(search));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!returnParams.some((name) => params.has(name))) return;
    returnParams.forEach((name) => params.delete(name));
    const query = params.toString();
    navigate(`${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`, { replace: true });
  }, []);

  useEffect(() => {
    if (!signin.ready) return;
    beginJourney(signin.reviewerId, signin.variant, signin.exposed);
  }, [signin.ready, signin.reviewerId, signin.variant, signin.exposed]);

  useEffect(() => watchForAbandon(), []);

  useEffect(() => {
    if (appFlow.ready && appFlow.flow && !appFlow.preview) {
      beginAppFlowJourney(appFlow.reviewerId, appFlow.flow, appFlow.exposed);
    }
  }, [appFlow.ready, appFlow.flow, appFlow.preview, appFlow.reviewerId, appFlow.exposed]);

  return { signinError, signin };
}
