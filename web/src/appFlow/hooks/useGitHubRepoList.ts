import { useCallback, useEffect, useState } from "react";
import { fetchGitHubRepos } from "../../api";
import { navigate } from "../../router";
import { resumeJourney, trackSignin, watchForAbandon } from "../../signinEvents";
import type { GitHubRepoChoice } from "../../types";
import { useRequest } from "../../useRequest";
import type { RequestState } from "../../useRequest";
import { useMe } from "./useMe";

// GitHub returns here after sign-in (signed_in) and after the app install page (the rest).
const returnParams = ["signed_in", "github", "installation_id", "setup_action"];
// Never settles, so useRequest stays "loading" and nothing is fetched.
const notStarted = new Promise<never>(() => {});

export function readGitHubReturn(search: string) {
  const params = new URLSearchParams(search);
  return { signedIn: params.get("signed_in") === "1", installed: params.get("github") === "installed" };
}

// The GitHub repositories page: the visitor's account and the repositories code-flow may read.
export function useGitHubRepoList(search: string) {
  const [returned] = useState(() => readGitHubReturn(search));
  const { me, signOut: endSession } = useMe();
  const signedIn = me.status === "ready" && me.data.signed_in;
  // Repositories are only listed for a signed-in visitor.
  const loadRepos = useCallback(
    (signal: AbortSignal) => (signedIn ? fetchGitHubRepos(signal) : notStarted),
    [signedIn],
  );
  const repoList = useRequest(loadRepos);
  const repos: RequestState<GitHubRepoChoice[]> = signedIn ? repoList : { status: "loading" };
  const choices = repos.status === "ready" ? repos.data : [];

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!returnParams.some((name) => params.has(name))) return;
    returnParams.forEach((name) => params.delete(name));
    const query = params.toString();
    navigate(`${window.location.pathname}${query ? `?${query}` : ""}`, { replace: true });
  }, []);

  useEffect(() => {
    resumeJourney();
    if (returned.signedIn) trackSignin("signin_completed");
  }, [returned.signedIn]);

  useEffect(() => watchForAbandon(), []);

  useEffect(() => {
    if (returned.installed && choices.length > 0) trackSignin("app_installed");
  }, [returned.installed, choices.length]);

  function signOut() {
    void endSession().finally(() => navigate("/"));
  }

  return { me, repos, installed: returned.installed, signOut };
}
