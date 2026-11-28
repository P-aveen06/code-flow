// Flow A's repos page (step 2 of 4): the visitor's GitHub account and the repositories code-flow may
// read, as a centred column of row cards. Behaviour and copy follow today's GitHubRepos page.
import { AppLink } from "../../../AppLink";
import { githubRepoPath, navigate } from "../../../router";
import { markRedirecting } from "../../../signinEvents";
import type { GitHubRepoChoice, Me } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { useGitHubRepoList } from "../../hooks/useGitHubRepoList";
import { useSignIn } from "../../SignInContext";
import { Button } from "../../ui/Button";
import { Avatar, Card, Chip, Header, Icon, PageColumn, Stepper } from "./kit";
import "./repos.css";

type SignedIn = Extract<Me, { signed_in: true }>;

export function ReposA({ search }: { search: string }) {
  const { me, repos, signOut } = useGitHubRepoList(search);
  const signIn = useSignIn();
  // Today's sign-in focuses the #import section of the landing page, which this page does not have.
  const startSignIn = signIn.piece === "today" ? () => navigate("/") : signIn.start;
  // A visitor who is not signed in is still on step 1.
  const step = me.status === "ready" && !me.data.signed_in ? 1 : 2;

  return (
    <>
      <Header />
      <PageColumn className="fa-repos">
        <Stepper step={step} />
        <div className="fa-repos__head">
          <div className="fa-repos__title">
            <h1>Your GitHub repositories</h1>
            {me.status === "ready" && me.data.signed_in && (
              <Account me={me.data} onSignOut={() => signOut()} />
            )}
          </div>
          {me.status === "ready" && me.data.signed_in && (
            <p className="fa-repos__lead">Pick a repository, then a branch to analyze.</p>
          )}
        </div>
        <div className="fa-repos__body">
          {me.status === "loading" && (
            <Card>
              <p role="status">Checking your GitHub sign-in…</p>
            </Card>
          )}
          {me.status === "error" && (
            <Card className="fa-repos__panel">
              <p role="alert">{me.message}</p>
              <RetryButton />
            </Card>
          )}
          {me.status === "ready" && !me.data.configured && (
            <Card>
              <p>
                GitHub sign-in is not set up on this server. <AppLink href="/">Paste a public URL instead</AppLink>.
              </p>
            </Card>
          )}
          {me.status === "ready" && me.data.configured && !me.data.signed_in && (
            <Card className="fa-repos__panel">
              <p>Sign in to see the repositories you allow code-flow to read.</p>
              <div className="fa-repos__actions">
                <Button variant="primary" onClick={startSignIn}>
                  <Icon name="github" size={18} />
                  Sign in with GitHub
                </Button>
                <Button variant="tertiary" to="/">or paste a public URL</Button>
              </div>
            </Card>
          )}
          {me.status === "ready" && me.data.signed_in && <RepoList me={me.data} repos={repos} />}
        </div>
      </PageColumn>
    </>
  );
}

function Account({ me, onSignOut }: { me: SignedIn; onSignOut: () => void }) {
  return (
    <div className="fa-account">
      <Avatar login={me.login} src={me.avatar_url || undefined} />
      <span className="fa-account__login">@{me.login}</span>
      <Button variant="tertiary" size="sm" onClick={onSignOut}>
        Sign out
        <Icon name="arrow-right" size={13} />
      </Button>
    </div>
  );
}

function RepoList({ me, repos }: { me: SignedIn; repos: RequestState<GitHubRepoChoice[]> }) {
  if (repos.status === "loading") {
    return (
      <Card>
        <p role="status">Loading your repositories…</p>
      </Card>
    );
  }
  if (repos.status === "error") {
    return (
      <Card className="fa-repos__panel">
        <p role="alert">Could not load your repositories.</p>
        <p className="fa-hint">{repos.message}</p>
        <RetryButton />
      </Card>
    );
  }

  const choices = repos.data;
  const chooseRepos = (
    <Button className="fa-repos__more" variant="secondary" href={me.install_url} onClick={() => markRedirecting()}>
      {choices.length > 0 ? "Add or remove repositories" : "Choose repositories on GitHub"}
      <Icon name="external" size={14} />
    </Button>
  );

  if (choices.length === 0) {
    return (
      <Card className="fa-repos__panel">
        <h2 className="fa-section-title">Choose repositories on GitHub</h2>
        <p>code-flow cannot see any of your repositories yet. Pick the ones it may read on GitHub.</p>
        {chooseRepos}
      </Card>
    );
  }

  return (
    <>
      <ul className="fa-repos__list" aria-label="Your repositories">
        {choices.map((repo) => (
          <li key={`${repo.installation_id}:${repo.id}`}>
            <RepoRow repo={repo} />
          </li>
        ))}
      </ul>
      {chooseRepos}
    </>
  );
}

function RepoRow({ repo }: { repo: GitHubRepoChoice }) {
  return (
    <AppLink href={githubRepoPath(repo.id)} className="fa-repo-row">
      <span className="fa-repo-row__icon" aria-hidden="true">
        <Icon name={repo.private ? "lock" : "repo"} size={22} />
      </span>
      <div className="fa-repo-row__body">
        <div className="fa-repo-row__name">
          <h2 className="fa-repo-row__title">{repo.full_name}</h2>
          {repo.private && (
            <Chip>
              <Icon name="lock" size={12} />
              Private
            </Chip>
          )}
        </div>
        <p className="fa-repo-row__meta">
          Default branch <code>{repo.default_branch}</code>
        </p>
      </div>
      <span className="fa-repo-row__go" aria-hidden="true">
        <Icon name="chevron-right" size={17} />
      </span>
    </AppLink>
  );
}

// The repo list has no retry of its own, so this link loads the page again.
function RetryButton() {
  return (
    <Button variant="secondary" size="sm" href={window.location.href}>
      Try again
    </Button>
  );
}
