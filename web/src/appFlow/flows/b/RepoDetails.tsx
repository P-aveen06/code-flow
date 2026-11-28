// Flow B's repo details: a workbench with the branches on the left. On the right are the latest
// commits of the chosen branch, the analyze form and, while the analysis runs, its progress strip.
import { useId, useState } from "react";
import { importProgress, importSteps } from "../../../pages/importHelpers";
import { githubReposPath, navigate, repoPath } from "../../../router";
import type { GitHubCommitList } from "../../../types";
import { useMe } from "../../hooks/useMe";
import { useRepoDetails } from "../../hooks/useRepoDetails";
import { Button } from "../../ui/Button";
import { AppShell, Header, Icon, Panel, StatusStrip, Table, TableRow, Toolbar } from "./kit";
import { Failure, VisibilityBadge, WorkspaceSidebar } from "./Repos";
import "./repos.css";

type RepoDetails = ReturnType<typeof useRepoDetails>;

const STEP_LABELS = importSteps.map((step) => step.label);
const COMMIT_COLUMNS = "112px minmax(0, 1fr) 176px 120px";

export function RepoDetailsB({ repoId, search }: { repoId: number; search: string }) {
  // Try again starts the page afresh, so the branches and the commits are requested again.
  const [attempt, setAttempt] = useState(0);
  return (
    <RepoDetailsPage
      key={attempt}
      repoId={repoId}
      search={search}
      onReload={() => setAttempt((count) => count + 1)}
    />
  );
}

function RepoDetailsPage({ repoId, search, onReload }: {
  repoId: number;
  search: string;
  onReload: () => void;
}) {
  const details = useRepoDetails(repoId, search);
  const { me, signOut } = useMe();
  const account = me.status === "ready" && me.data.signed_in ? me.data : null;
  const repo = details.branches.status === "ready" ? details.branches.data.repo : null;
  const title = repo?.full_name ?? (details.branches.status === "error" ? "Repository" : "Loading the repository…");

  function endSession() {
    void signOut().finally(() => navigate("/"));
  }

  return (
    <div className="fb-repo-details">
      <AppShell sidebar={<WorkspaceSidebar account={account} onSignOut={endSession} />}>
        <Header>
          <div className="fb-repo-details__title">
            <Button variant="tertiary" to={githubReposPath} className="fb-repo-details__back">
              <Icon name="arrow-left" />
              Your repositories
            </Button>
            <h1 className="fb-repo-details__heading">
              <Icon name="repo" size={20} />
              {title}
              {repo?.private && <VisibilityBadge isPrivate />}
            </h1>
            {repo?.private && (
              <p className="fb-repo-details__note">Private: only you will see what you analyze here.</p>
            )}
          </div>
        </Header>
        <div className="fb-repo-details__body">
          <div className="fb-repo-details__branches">
            <Panel
              title={<span className="fb-repo-details__pane-title"><Icon name="branch" size={16} />Branches</span>}
            >
              <BranchList details={details} />
            </Panel>
          </div>
          <CommitPane details={details} onReload={onReload} />
        </div>
      </AppShell>
    </div>
  );
}

function BranchList({ details }: { details: RepoDetails }) {
  const { branches, branch, setBranch } = details;
  if (branches.status === "loading") {
    return <p role="status" className="fb-repo-details__status">Loading branches…</p>;
  }
  // A failed branch list is reported in the commit pane, next to its try again button.
  if (branches.status === "error") return null;
  const { repo, branches: names } = branches.data;
  return (
    <ul className="fb-repo-details__branch-list" aria-label="Branches">
      {names.map((name) => (
        <li key={name}>
          <button
            type="button"
            className="fb-repo-details__branch"
            aria-pressed={name === branch}
            onClick={() => setBranch(name)}
          >
            <Icon name="branch" size={15} />
            <code>{name}</code>
            {name === repo.default_branch && <span className="fb-repos__badge">default</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function CommitPane({ details, onReload }: { details: RepoDetails; onReload: () => void }) {
  const headingId = useId();
  return (
    <section className="fb-repo-details__commits" aria-labelledby={headingId}>
      <CommitsToolbar headingId={headingId} details={details} />
      <CommitsBody details={details} onReload={onReload} />
    </section>
  );
}

function CommitsToolbar({ headingId, details }: { headingId: string; details: RepoDetails }) {
  const { branch, commits, commitCount } = details;
  const list = commits.status === "ready" ? commits.data : null;
  const count = list?.commits.length ?? 0;
  const { limit } = list ?? { limit: 0 };
  const showHint = Boolean(list) && commitCount.ready;

  return (
    <Toolbar label="Latest commits">
      <div className="fb-repo-details__heading-block">
        <h2 id={headingId} className="fb-repo-details__section-title">
          {list ? `Latest ${count} ${count === 1 ? "commit" : "commits"}` : "Latest commits"}
          {branch && <> on <code>{branch}</code></>}
        </h2>
        {showHint && (
          <p className="fb-repo-details__hint">
            Up to {limit} commits, set by the <code>branch_commit_count</code> feature flag.
            {count > 0 && count < limit && ` This branch has ${count}.`}
          </p>
        )}
      </div>
      {list && <AnalyzeForm details={details} />}
    </Toolbar>
  );
}

// The subfolder and the analyze button. While an analysis runs (and after it is ready), the form
// is disabled and the progress strip below takes its place. A failed analysis can be started again.
function AnalyzeForm({ details }: { details: RepoDetails }) {
  const inputId = useId();
  const { commits, subdir, setSubdir, formError, analyze, busy, submitting, job, update, pollError } = details;
  if (commits.status !== "ready") return null;
  const count = commits.data.commits.length;
  const failed = Boolean(pollError) || update?.status === "error";
  const running = Boolean(job) && !failed;

  return (
    <form noValidate className="fb-repo-details__form" onSubmit={(event) => { event.preventDefault(); analyze(); }}>
      <fieldset className="fb-repo-details__fields" disabled={busy || count === 0 || running}>
        <label className="fb-repo-details__label" htmlFor={inputId}>Subfolder (optional)</label>
        <input
          id={inputId}
          className="fb-repo-details__input"
          type="text"
          value={subdir}
          onChange={(event) => setSubdir(event.target.value)}
        />
        <p className="fb-repo-details__field-hint">Only commits that change this folder are analyzed.</p>
        {!running && (
          <Button type="submit" variant="primary" className="fb-repo-details__submit" disabled={busy || count === 0}>
            <Icon name="play" size={14} />
            {submitting ? "Starting analysis…" : `Analyze ${count} ${count === 1 ? "commit" : "commits"}`}
          </Button>
        )}
      </fieldset>
      {formError && <p role="alert" className="fb-repo-details__form-error">{formError}</p>}
    </form>
  );
}

function CommitsBody({ details, onReload }: { details: RepoDetails; onReload: () => void }) {
  const { branches, commitCount, commits } = details;
  if (branches.status === "error") return <Failure message={branches.message} onRetry={onReload} />;
  if (branches.status === "loading" || !commitCount.ready) {
    return <p role="status" className="fb-repo-details__status">Loading the latest commits…</p>;
  }

  return (
    <>
      <Analysis details={details} />
      <div className="fb-repo-details__table">
        {commits.status === "loading" && <p role="status" className="fb-repo-details__status">Loading commits…</p>}
        {commits.status === "error" && <Failure message={commits.message} onRetry={onReload} />}
        {commits.status === "ready" && (
          commits.data.commits.length === 0
            ? <p className="fb-repo-details__status">This branch has no commits.</p>
            : <CommitTable commits={commits.data} />
        )}
      </div>
    </>
  );
}

// The analysis of the chosen branch: its steps and progress while it runs, and its outcome.
function Analysis({ details }: { details: RepoDetails }) {
  const { job, update, pollError, retry } = details;
  if (!job) return null;
  const { step, text, progress, warning } = importProgress(job.status, update);
  if (pollError || update?.status === "error") {
    return <Failure message={pollError || text} onRetry={retry} />;
  }

  return (
    <StatusStrip label="Import progress" steps={STEP_LABELS} current={step}>
      <div className="fb-repo-details__progress">
        <div className="fb-repo-details__progress-main">
          <div className="fb-repo-details__progress-text">
            <span>{text}</span>
            {update && (
              <span className="fb-repo-details__muted" title={`Elapsed time ${update.seconds.toFixed(1)} seconds`}>
                {update.seconds.toFixed(1)} s
              </span>
            )}
          </div>
          {progress && <progress aria-label="Commits analyzed" value={progress.current} max={progress.total} />}
          {warning && <p className="fb-repo-details__muted">{warning}</p>}
        </div>
        {update?.status === "ready" && (
          <Button variant="primary" to={repoPath(job.id)} className="fb-repo-details__open">
            <Icon name="graph" />
            Open
            <Icon name="arrow-right" size={14} />
          </Button>
        )}
      </div>
    </StatusStrip>
  );
}

function CommitTable({ commits }: { commits: GitHubCommitList }) {
  return (
    <Table
      label={`Latest commits on ${commits.branch}`}
      columns={COMMIT_COLUMNS}
      head={["SHA", "Message", "Author", "Date"]}
    >
      {commits.commits.map((commit) => {
        const short = commit.sha.slice(0, 7);
        return (
          <TableRow key={commit.sha}>
            <a href={commit.url} target="_blank" rel="noreferrer" title={`Open ${short} on GitHub`}>
              <code>{short}</code>
            </a>
            <span title={commit.message}>{commit.message || "(no message)"}</span>
            <span className="fb-repo-details__muted" title={commit.author}>{commit.author}</span>
            <span className="fb-repo-details__muted">{formatDate(commit.date)}</span>
          </TableRow>
        );
      })}
    </Table>
  );
}

// The same date text as today's repo details page.
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
