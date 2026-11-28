import { useCallback, useState } from "react";
import { fetchMe, signInUrl, signOut } from "../api";
import { AppLink } from "../AppLink";
import { githubReposPath } from "../router";
import { markRedirecting, trackSignin } from "../signinEvents";
import { useRequest } from "../useRequest";

export function startSignIn() {
  trackSignin("import_started");
  trackSignin("signin_started");
  markRedirecting();
}

// The landing card for the github_signin variant. Signed-in visitors continue on /github.
export function SignInImport({ onSignedOut, onUseUrl }: {
  onSignedOut: () => void;
  onUseUrl: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const loadMe = useCallback((signal: AbortSignal) => fetchMe(signal), [revision]);
  const me = useRequest(loadMe);

  async function leave() {
    try {
      await signOut();
    } finally {
      setRevision((value) => value + 1);
      onSignedOut();
    }
  }

  return (
    <section className="card import-card signin-card" aria-labelledby="signin-title">
      <h2 id="signin-title">Analyze a repo from your GitHub</h2>
      {me.status === "loading" && <p role="status">Checking your GitHub sign-in…</p>}
      {me.status === "error" && <p role="alert">{me.message}</p>}
      {me.status === "ready" && !me.data.configured && (
        <>
          <p className="signin-card__lead">
            GitHub sign-in is not set up on this server yet. You can still analyze a public repo.
          </p>
          <div className="signin-card__actions">
            <button type="button" className="btn btn--primary" onClick={onUseUrl}>Paste a public URL</button>
          </div>
        </>
      )}
      {me.status === "ready" && me.data.configured && !me.data.signed_in && (
        <>
          <p className="signin-card__lead">
            Sign in to pick any repo you allow, including private ones. code-flow can only read the
            code of the repos you choose, and only you can see your private imports.
          </p>
          <div className="signin-card__actions">
            <a className="btn btn--primary" href={signInUrl()} onClick={startSignIn}>Sign in with GitHub</a>
            <button type="button" className="link-button" onClick={onUseUrl}>or paste a public URL</button>
          </div>
        </>
      )}
      {me.status === "ready" && me.data.signed_in && (
        <>
          <p className="signin-card__account">
            {me.data.avatar_url && <img src={me.data.avatar_url} alt="" width="20" height="20" />}
            Signed in as <strong>@{me.data.login}</strong>
            <button type="button" className="link-button" onClick={() => void leave()}>Sign out</button>
          </p>
          <div className="signin-card__actions">
            <AppLink href={githubReposPath} className="btn btn--primary">Choose a repository</AppLink>
            <button type="button" className="link-button" onClick={onUseUrl}>or paste a public URL</button>
          </div>
        </>
      )}
    </section>
  );
}
