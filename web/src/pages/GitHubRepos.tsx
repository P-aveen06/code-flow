import { AppLink } from "../AppLink";
import { useGitHubRepoList } from "../appFlow/hooks/useGitHubRepoList";
import { signInUrl } from "../api";
import { githubRepoPath } from "../router";
import { markRedirecting } from "../signinEvents";
import type { GitHubRepoChoice, Me } from "../types";
import type { RequestState } from "../useRequest";
import { startSignIn } from "./SignInImport";

type SignedIn = Extract<Me, { signed_in: true }>;

export function GitHubRepos({ search }: { search: string }) {
  const { me, repos, signOut } = useGitHubRepoList(search);

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
          <RepoList me={me.data} repos={repos} onSignOut={signOut} />
        )}
      </section>
    </main>
  );
}

function RepoList({ me, repos, onSignOut }: {
  me: SignedIn;
  repos: RequestState<GitHubRepoChoice[]>;
  onSignOut: () => void;
}) {
  const choices = repos.status === "ready" ? repos.data : [];

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
