// Flow C "Canvas": the repos page (C3). Your repositories as cards on the canvas, the account in the
// header, and a dashed tile that opens GitHub to add or remove repositories. The states and copy
// follow today's repos page.
import type { ReactNode } from "react";
import { AppLink } from "../../../AppLink";
import { githubRepoPath } from "../../../router";
import { markRedirecting } from "../../../signinEvents";
import type { GitHubRepoChoice, Me } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { useGitHubRepoList } from "../../hooks/useGitHubRepoList";
import { useSignIn } from "../../SignInContext";
import { Button } from "../../ui/Button";
import { AvatarMenu, CanvasBackground, Header, Icon, Pill } from "./kit";
import "./repos.css";

type SignedIn = Extract<Me, { signed_in: true }>;

export function ReposC({ search }: { search: string }) {
  const { me, repos, signOut } = useGitHubRepoList(search);
  const { start } = useSignIn();
  const listed = me.status === "ready" && me.data.signed_in && repos.status === "ready" && repos.data.length > 0;

  return (
    <>
      <Header right={me.status === "ready" ? <AvatarMenu me={me.data} onSignOut={signOut} /> : undefined} />
      <CanvasBackground className="fc-repos">
        <main className="fc-repos__main">
          <div className="fc-repos__intro">
            <h1 className="fc-repos__title">Your GitHub repositories</h1>
            {listed && <p className="fc-repos__hint">Pick a repository, then a branch to analyze.</p>}
          </div>
          <ReposBody me={me} repos={repos} onStart={start} />
        </main>
      </CanvasBackground>
    </>
  );
}

function ReposBody({ me, repos, onStart }: {
  me: RequestState<Me>;
  repos: RequestState<GitHubRepoChoice[]>;
  onStart: () => void;
}) {
  if (me.status === "loading") {
    return <p role="status" className="fc-repos__status">Checking your GitHub sign-in…</p>;
  }
  if (me.status === "error") return <p role="alert" className="fc-repos__alert">{me.message}</p>;
  if (!me.data.configured) {
    return (
      <Panel>
        <p>
          GitHub sign-in is not set up on this server. <Button variant="tertiary" size="sm" to="/">Paste a public URL instead</Button>
        </p>
      </Panel>
    );
  }
  if (!me.data.signed_in) {
    return (
      <Panel>
        <p>Sign in to see the repositories you allow code-flow to read.</p>
        <div className="fc-repos__actions">
          <Button variant="primary" onClick={() => onStart()}>
            <Icon name="github" size={16} />
            Sign in with GitHub
          </Button>
          <Button variant="tertiary" to="/">or paste a public URL</Button>
        </div>
      </Panel>
    );
  }
  return <RepoList me={me.data} repos={repos} />;
}

function RepoList({ me, repos }: { me: SignedIn; repos: RequestState<GitHubRepoChoice[]> }) {
  if (repos.status === "loading") return <p role="status" className="fc-repos__status">Loading your repositories…</p>;
  if (repos.status === "error") return <p role="alert" className="fc-repos__alert">{repos.message}</p>;
  if (repos.data.length === 0) {
    return (
      <Panel>
        <p>code-flow cannot see any of your repositories yet. Pick the ones it may read on GitHub.</p>
        <Button variant="primary" href={me.install_url} onClick={() => markRedirecting()}>
          Choose repositories on GitHub
        </Button>
      </Panel>
    );
  }
  return (
    <ul className="fc-repos__grid" aria-label="Your repositories">
      {repos.data.map((repo) => (
        <li key={`${repo.installation_id}:${repo.id}`}>
          <RepoCard repo={repo} />
        </li>
      ))}
      <li>
        <a className="fc-repos__add" href={me.install_url} onClick={() => markRedirecting()}>
          <span className="fc-repos__add-icon" aria-hidden="true">
            <Icon name="plus" size={23} />
          </span>
          <span className="fc-repos__add-label">
            Add or remove repositories
            <Icon name="external" size={14} />
          </span>
        </a>
      </li>
    </ul>
  );
}

function RepoCard({ repo }: { repo: GitHubRepoChoice }) {
  const [owner, name] = repo.full_name.split("/");
  const label = [repo.full_name, repo.default_branch, repo.private && "Private"].filter(Boolean).join(" · ");
  return (
    <AppLink href={githubRepoPath(repo.id)} className="fc-repos__card" label={label}>
      <span className="fc-repos__card-top">
        <span className="fc-repos__repo-icon" aria-hidden="true">
          <Icon name="repo" size={23} />
        </span>
        <span className="fc-repos__open" aria-hidden="true">
          <Icon name="arrow-up-right" size={18} />
        </span>
      </span>
      <span className="fc-repos__card-name">
        <span className="fc-repos__owner">{owner}</span>
        <h2 className="fc-repos__name">{name}</h2>
      </span>
      <span className="fc-repos__chips">
        <Pill>
          <Icon name="branch" size={13} />
          <code>{repo.default_branch}</code>
        </Pill>
        {repo.private && (
          <Pill>
            <Icon name="lock" size={12} />
            Private
          </Pill>
        )}
      </span>
    </AppLink>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="fc-repos__panel">{children}</div>;
}
