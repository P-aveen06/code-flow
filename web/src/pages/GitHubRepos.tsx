import { useCallback, useEffect, useState } from "react";
import { fetchGitHubRepos, fetchMe, signInUrl, signOut } from "../api";
import { AppLink } from "../AppLink";
import { githubRepoPath, navigate } from "../router";
import { markRedirecting, resumeJourney, trackSignin, watchForAbandon } from "../signinEvents";
import type { Me } from "../types";
import { useRequest } from "../useRequest";
import { startSignIn } from "./SignInImport";

type SignedIn = Extract<Me, { signed_in: true }>;

// GitHub returns here after sign-in (signed_in) and after the app install page (the rest).
const returnParams = ["signed_in", "github", "installation_id", "setup_action"];

export function readGitHubReturn(search: string) {
  const params = new URLSearchParams(search);
  return { signedIn: params.get("signed_in") === "1", installed: params.get("github") === "installed" };
}

export function GitHubRepos({ search }: { search: string }) {
  const [returned] = useState(() => readGitHubReturn(search));
  const [revision, setRevision] = useState(0);
  const loadMe = useCallback((signal: AbortSignal) => fetchMe(signal), [revision]);
  const me = useRequest(loadMe);

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

  async function leave() {
    try {
      await signOut();
    } finally {
      setRevision((value) => value + 1);
      navigate("/");
    }
  }

  return (
    <main className="github-page">
      <section className="card github-card" aria-labelledby="github-repos-title">
        <h1 id="github-repos-title">Your GitHub repositories</h1>
        {me.status === "loading" && <p role="status">Checking your GitHub sign-in…</p>}
        {me.status === "error" && <p role="alert">{me.message}</p>}
        {me.status === "ready" && !me.data.configured && (
          <p>GitHub sign-in is not set up on this server. <AppLink href="/">Paste a public URL instead</AppLink>.</p>
        )}
        {me.status === "ready" && me.data.configured && !me.data.signed_in && (
          <>
            <p className="signin-card__lead">Sign in to see the repositories you allow code-flow to read.</p>
            <div className="signin-card__actions">
              <a className="btn btn--primary" href={signInUrl()} onClick={startSignIn}>Sign in with GitHub</a>
              <AppLink href="/" className="link-button">or paste a public URL</AppLink>
            </div>
          </>
        )}
        {me.status === "ready" && me.data.signed_in && (
          <RepoList me={me.data} installed={returned.installed} onSignOut={() => void leave()} />
        )}
      </section>
    </main>
  );
}

function RepoList({ me, installed, onSignOut }: { me: SignedIn; installed: boolean; onSignOut: () => void }) {
  const repos = useRequest(fetchGitHubRepos);
  const choices = repos.status === "ready" ? repos.data : [];

  useEffect(() => {
    if (installed && choices.length > 0) trackSignin("app_installed");
  }, [installed, choices.length]);

  const chooseRepos = (
    <a className="btn" href={me.install_url} onClick={() => markRedirecting()}>
      {choices.length ? "Add or remove repositories" : "Choose repositories on GitHub"}
    </a>
  );

  return (
    <>
      <p className="signin-card__account">
        {me.avatar_url && <img src={me.avatar_url} alt="" width="20" height="20" />}
        Signed in as <strong>@{me.login}</strong>
        <button type="button" className="link-button" onClick={onSignOut}>Sign out</button>
      </p>
      {repos.status === "loading" && <p role="status">Loading your repositories…</p>}
      {repos.status === "error" && <p role="alert">{repos.message}</p>}
      {repos.status === "ready" && !choices.length && (
        <p>code-flow cannot see any of your repositories yet. Pick the ones it may read on GitHub.</p>
      )}
      {choices.length > 0 && (
        <>
          <p className="muted">Pick a repository, then a branch to analyze.</p>
          <ul className="github-repos" aria-label="Your repositories">
            {choices.map((repo) => (
              <li key={`${repo.installation_id}:${repo.id}`}>
                <AppLink href={githubRepoPath(repo.id)} className="github-repos__link">
                  <strong>{repo.full_name}</strong>
                  {repo.private && <span className="status-chip repo-private">Private</span>}
                  <span className="muted">{repo.default_branch}</span>
                </AppLink>
              </li>
            ))}
          </ul>
        </>
      )}
      {repos.status === "ready" && <div className="signin-card__actions">{chooseRepos}</div>}
    </>
  );
}
