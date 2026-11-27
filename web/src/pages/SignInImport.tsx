import { useCallback, useEffect, useState } from "react";
import { fetchGitHubRepos, fetchMe, signInUrl, signOut } from "../api";
import { markRedirecting, trackSignin } from "../signinEvents";
import type { GitHubRepoChoice, Me, PickedImportRequest } from "../types";
import { useRequest } from "../useRequest";
import { validateImport } from "./importHelpers";

type SignedIn = Extract<Me, { signed_in: true }>;

function startSignIn() {
  trackSignin("import_started");
  trackSignin("signin_started");
  markRedirecting();
}

export function SignInImport({ busy, submitting, error, installed, onImport, onSignedOut, onUseUrl }: {
  busy: boolean;
  submitting: boolean;
  error: string | null;
  // True when GitHub just sent the visitor back from installing the app.
  installed: boolean;
  onImport: (body: PickedImportRequest) => void;
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
      {me.status === "ready" && !me.data.signed_in && (
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
        <RepoPicker
          me={me.data} busy={busy} submitting={submitting} error={error} installed={installed}
          onImport={onImport} onSignOut={leave} onUseUrl={onUseUrl}
        />
      )}
    </section>
  );
}

function RepoPicker({ me, busy, submitting, error, installed, onImport, onSignOut, onUseUrl }: {
  me: SignedIn;
  busy: boolean;
  submitting: boolean;
  error: string | null;
  installed: boolean;
  onImport: (body: PickedImportRequest) => void;
  onSignOut: () => void;
  onUseUrl: () => void;
}) {
  const repos = useRequest(fetchGitHubRepos);
  const [selected, setSelected] = useState("");
  const [subdir, setSubdir] = useState("");
  const [maxCommits, setMaxCommits] = useState("30");
  const [formError, setFormError] = useState<string | null>(null);
  const choices = repos.status === "ready" ? repos.data : [];
  const repo = choices.find(({ id }) => String(id) === selected) ?? choices[0];

  useEffect(() => {
    if (installed && choices.length > 0) trackSignin("app_installed");
  }, [installed, choices.length]);

  function submit() {
    if (!repo) return;
    const result = validateImport({ url: `https://github.com/${repo.full_name}`, subdir, maxCommits });
    if (!("body" in result)) {
      setFormError(result.message);
      return;
    }
    setFormError(null);
    trackSignin("repo_selected");
    onImport({
      github_repo_id: repo.id, installation_id: repo.installation_id,
      subdir: result.body.subdir, max_commits: result.body.max_commits,
    });
  }

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
        <>
          <p>code-flow cannot see any of your repositories yet. Pick the ones it may read on GitHub.</p>
          <div className="signin-card__actions">{chooseRepos}</div>
        </>
      )}
      {repos.status === "ready" && repo && (
        <form noValidate onSubmit={(event) => { event.preventDefault(); if (!busy) submit(); }}>
          <fieldset disabled={busy}>
            <div className="import-card__url">
              <label className="field__label" htmlFor="picker-repo">Repository</label>
              <select
                id="picker-repo" className="input" value={String(repo.id)}
                onChange={(event) => { setSelected(event.target.value); trackSignin("repo_selected"); }}
              >
                {choices.map((choice: GitHubRepoChoice) => (
                  <option key={choice.id} value={String(choice.id)}>
                    {choice.full_name}{choice.private ? " (private)" : ""}
                  </option>
                ))}
              </select>
              {repo.private && (
                <p className="muted field__hint">Private: only you will see this import.</p>
              )}
            </div>
            <div>
              <label className="field__label" htmlFor="picker-subdir">Subfolder (optional)</label>
              <input
                id="picker-subdir" className="input" type="text" value={subdir}
                onChange={(event) => setSubdir(event.target.value)}
              />
            </div>
            <div>
              <label className="field__label" htmlFor="picker-maxCommits">Number of recent commits</label>
              <input
                id="picker-maxCommits" className="input" type="number" min="1" max="200" step="1"
                value={maxCommits} onChange={(event) => setMaxCommits(event.target.value)}
              />
            </div>
            {(formError || error) && <p id="import-error" role="alert">{formError || error}</p>}
            <button type="submit" className="btn btn--primary">
              {submitting ? "Starting analysis…" : "Analyze repository"}
            </button>
          </fieldset>
        </form>
      )}
      <div className="signin-card__actions">
        {repos.status === "ready" && choices.length > 0 && chooseRepos}
        <button type="button" className="link-button" onClick={onUseUrl}>or paste a public URL</button>
      </div>
    </>
  );
}
