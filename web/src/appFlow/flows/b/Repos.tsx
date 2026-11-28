// Flow B's repositories page: the workbench shell (a sidebar with the account, a header) and the
// visitor's repositories as a dense table. Each row opens that repository's details.
import { useState, type ReactNode } from "react";
import { AppLink } from "../../../AppLink";
import { githubRepoPath, githubReposPath } from "../../../router";
import { markRedirecting } from "../../../signinEvents";
import type { GitHubRepoChoice, Me } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { useGitHubRepoList } from "../../hooks/useGitHubRepoList";
import { useSignIn } from "../../SignInContext";
import { Button } from "../../ui/Button";
import { AppShell, Avatar, Header, Icon, Sidebar, SidebarLink, Table, TableRow } from "./kit";
import "./repos.css";

type SignedInMe = Extract<Me, { signed_in: true }>;

const REPO_COLUMNS = "minmax(0, 6fr) minmax(0, 2fr) minmax(0, 2fr) minmax(0, 2fr)";

export function ReposB({ search }: { search: string }) {
  // Try again starts the page afresh, so the account and the repositories are asked for again.
  const [attempt, setAttempt] = useState(0);
  return <ReposPage key={attempt} search={search} onReload={() => setAttempt((count) => count + 1)} />;
}

function ReposPage({ search, onReload }: { search: string; onReload: () => void }) {
  const { me, repos, signOut } = useGitHubRepoList(search);
  const account = me.status === "ready" && me.data.signed_in ? me.data : null;
  const choices = repos.status === "ready" ? repos.data : [];
  const addOrRemove = account && choices.length > 0 ? (
    <InstallButton url={account.install_url}>
      <Icon name="github" />
      Add or remove repositories
      <Icon name="external" size={14} />
    </InstallButton>
  ) : undefined;

  return (
    <div className="fb-repos">
      <AppShell sidebar={<WorkspaceSidebar account={account} onSignOut={signOut} />}>
        <Header right={addOrRemove}>
          <div className="fb-repos__title">
            <h1>Your GitHub repositories</h1>
            <p className="fb-repos__hint">Pick a repository, then a branch to analyze.</p>
          </div>
        </Header>
        <div className="fb-repos__body">
          <div className="fb-repos__card">
            <RepoList me={me} repos={repos} onReload={onReload} />
          </div>
        </div>
      </AppShell>
    </div>
  );
}

function RepoList({ me, repos, onReload }: {
  me: RequestState<Me>;
  repos: RequestState<GitHubRepoChoice[]>;
  onReload: () => void;
}) {
  if (me.status === "loading") {
    return <p role="status" className="fb-repos__state">Checking your GitHub sign-in…</p>;
  }
  if (me.status === "error") return <Failure message={me.message} onRetry={onReload} />;
  if (!me.data.configured) {
    return (
      <div className="fb-repos__state">
        <p>GitHub sign-in is not set up on this server yet. You can still analyze a public repo.</p>
        <Button to="/" variant="secondary">Paste a public URL</Button>
      </div>
    );
  }
  if (!me.data.signed_in) return <SignedOut />;
  if (repos.status === "loading") {
    return <p role="status" className="fb-repos__state">Loading your repositories…</p>;
  }
  if (repos.status === "error") return <Failure message={repos.message} onRetry={onReload} />;
  if (repos.data.length === 0) {
    return (
      <div className="fb-repos__state">
        <p>code-flow cannot see any of your repositories yet. Pick the ones it may read on GitHub.</p>
        <InstallButton url={me.data.install_url} variant="primary">
          <Icon name="github" />
          Choose repositories on GitHub
        </InstallButton>
      </div>
    );
  }
  return <RepoTable repos={repos.data} />;
}

function SignedOut() {
  return (
    <div className="fb-repos__state">
      <p>Sign in to see the repositories you allow code-flow to read.</p>
      <div className="fb-repos__actions">
        <SignInButton />
        <Button to="/" variant="tertiary">or paste a public URL</Button>
      </div>
    </div>
  );
}

// The sign-in piece decides where start() goes. Today's sign-in lives on the landing page, and
// start() can only focus it from there, so this button links to the landing page instead.
function SignInButton() {
  const signIn = useSignIn();
  if (signIn.piece === "today") {
    return <Button to="/" variant="primary"><Icon name="github" />Sign in with GitHub</Button>;
  }
  return <Button variant="primary" onClick={signIn.start}><Icon name="github" />Sign in with GitHub</Button>;
}

// A failed load or import: its message, and a button that tries again.
export function Failure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="fb-repos__state">
      <p role="alert" className="fb-repos__failure"><Icon name="info" />{message}</p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}

function RepoTable({ repos }: { repos: GitHubRepoChoice[] }) {
  return (
    <div className="fb-repos__table">
      <Table
        label="Your GitHub repositories"
        columns={REPO_COLUMNS}
        head={["Repository", "Visibility", "Default branch", <span className="fb-repos__sr-only">Open</span>]}
      >
        {repos.map((repo) => (
          <TableRow key={`${repo.installation_id}:${repo.id}`}>
            <span className="fb-repos__name">
              <Icon name="repo" />
              <AppLink href={githubRepoPath(repo.id)} className="fb-repos__link">{repo.full_name}</AppLink>
            </span>
            <VisibilityBadge isPrivate={repo.private} />
            <span className="fb-repos__branch">
              <Icon name="branch" size={14} />
              <code>{repo.default_branch}</code>
            </span>
            <span className="fb-repos__select">
              Select
              <Icon name="arrow-right" />
            </span>
          </TableRow>
        ))}
      </Table>
    </div>
  );
}

// A GitHub link for the install or repository picker. Starting it marks the journey as leaving.
function InstallButton({ url, variant = "secondary", children }: {
  url: string;
  variant?: "primary" | "secondary";
  children: ReactNode;
}) {
  return (
    <Button href={url} variant={variant} onClick={() => markRedirecting()}>
      {children}
    </Button>
  );
}

export function VisibilityBadge({ isPrivate }: { isPrivate: boolean }) {
  return (
    <span className="fb-repos__badge">
      <Icon name={isPrivate ? "lock" : "globe"} size={12} />
      {isPrivate ? "Private" : "Public"}
    </span>
  );
}

// The sidebar both repository pages share: the logo, the signed-in account with sign-out, and the
// navigation. "Analyzed" opens the landing page, which lists the analyzed repositories.
export function WorkspaceSidebar({ account, onSignOut }: {
  account: SignedInMe | null;
  onSignOut: () => void;
}) {
  return (
    <Sidebar
      label="Workspace"
      account={account && (
        <div className="fb-repos__account">
          <Avatar login={account.login} src={account.avatar_url} />
          <div className="fb-repos__account-text">
            <span className="fb-repos__login">@{account.login}</span>
            <Button variant="tertiary" size="sm" className="fb-repos__sign-out" onClick={onSignOut}>
              <Icon name="sign-out" />
              Sign out
            </Button>
          </div>
        </div>
      )}
    >
      <SidebarLink href={githubReposPath} active>
        <Icon name="repo" />
        Repositories
      </SidebarLink>
      <SidebarLink href="/">
        <Icon name="graph" />
        Analyzed
      </SidebarLink>
    </Sidebar>
  );
}
