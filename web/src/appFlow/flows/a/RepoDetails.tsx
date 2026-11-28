// Flow A's repo details (step 3 of 4): the branches as radio cards, the latest commits of the chosen
// branch, the subfolder under "Advanced", and a sticky bar with Analyze. While the import runs, the
// column becomes the progress card (A4b). Behaviour and copy follow today's GitHubRepo page and
// ImportProgress card.
import { displaySubdir, importProgress, importSteps } from "../../../pages/importHelpers";
import { githubReposPath, repoPath } from "../../../router";
import type { GitHubCommit, GitHubCommitList, GitHubRepoChoice, ImportStatus } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { useRepoDetails, type PickedImportJob } from "../../hooks/useRepoDetails";
import { Button } from "../../ui/Button";
import { Callout, Card, Chip, Header, Icon, PageColumn, Stepper } from "./kit";
import "./repos.css";

type RepoDetails = ReturnType<typeof useRepoDetails>;

// The commits shown before "Show all".
const SHOWN_COMMITS = 5;

export function RepoDetailsA({ repoId, search }: { repoId: number; search: string }) {
  const details = useRepoDetails(repoId, search);
  const { branches, job } = details;

  return (
    <>
      <Header />
      <form
        className="fa-repo-details"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          details.analyze();
        }}
      >
        <PageColumn className="fa-repo-details__page">
          <Stepper step={3} />
          {branches.status === "ready" && job ? (
            <ImportCard
              repoName={branches.data.repo.full_name}
              branch={details.branch}
              subdir={job.body.subdir}
              job={job}
              update={details.update}
              pollError={details.pollError}
              onRetry={details.retry}
            />
          ) : (
            <RepoPage details={details} />
          )}
        </PageColumn>
        {branches.status === "ready" && !job && (
          <AnalyzeBar
            repoName={branches.data.repo.full_name}
            branch={details.branch}
            subdir={details.subdir}
            commits={details.commits}
            submitting={details.submitting}
            formError={details.formError}
          />
        )}
      </form>
    </>
  );
}

function BackLink() {
  return (
    <Button variant="tertiary" size="sm" to={githubReposPath} className="fa-repo-details__back">
      <Icon name="arrow-left" size={16} />
      Your repositories
    </Button>
  );
}

function RepoPage({ details }: { details: RepoDetails }) {
  const { branches } = details;

  if (branches.status === "loading") {
    return (
      <>
        <BackLink />
        <Card>
          <p role="status">Loading the repository…</p>
        </Card>
      </>
    );
  }
  if (branches.status === "error") {
    return (
      <>
        <BackLink />
        <Callout role="alert">{branches.message}</Callout>
      </>
    );
  }

  const { repo, branches: names } = branches.data;
  return (
    <>
      <div className="fa-repo-details__head">
        <BackLink />
        <div className="fa-repo-details__title">
          <h1>{repo.full_name}</h1>
          {repo.private && (
            <Chip>
              <Icon name="lock" size={12} />
              Private
            </Chip>
          )}
        </div>
        {repo.private && <p className="fa-hint">Private: only you will see what you analyze here.</p>}
      </div>
      <BranchCard repo={repo} names={names} details={details} />
    </>
  );
}

function BranchCard({ repo, names, details }: {
  repo: GitHubRepoChoice;
  names: string[];
  details: RepoDetails;
}) {
  const { branch, setBranch, commitCount, commits, subdir, setSubdir } = details;

  return (
    <Card padding="compact" className="fa-repo-details__card">
      <section className="fa-repo-details__section" aria-labelledby="branch-picker-title">
        <h2 id="branch-picker-title" className="fa-section-title">Choose a branch</h2>
        <div className="fa-branches" role="radiogroup" aria-labelledby="branch-picker-title">
          {names.map((name) => {
            const selected = name === branch;
            return (
              <label key={name} className={cx("fa-branch", selected && "fa-branch--selected")}>
                <input
                  type="radio"
                  name="branch"
                  value={name}
                  checked={selected}
                  onChange={() => setBranch(name)}
                />
                <code className="fa-branch__name">{name}</code>
                {name === repo.default_branch && <Chip tone="accent">Default</Chip>}
              </label>
            );
          })}
        </div>
      </section>
      {commitCount.ready ? <CommitSection commits={commits} /> : <p role="status" className="fa-hint">Loading…</p>}
      <details className="fa-disclosure fa-advanced">
        <summary>Advanced</summary>
        <div className="fa-advanced__body">
          <label className="fa-field__label" htmlFor="repo-subdir">Subfolder (optional)</label>
          <input
            id="repo-subdir"
            className="fa-input"
            type="text"
            value={subdir}
            aria-describedby="repo-subdir-hint"
            onChange={(event) => setSubdir(event.target.value)}
          />
          <p id="repo-subdir-hint" className="fa-hint">Only commits that change this folder are analyzed.</p>
        </div>
      </details>
    </Card>
  );
}

function CommitSection({ commits }: { commits: RequestState<GitHubCommitList> }) {
  if (commits.status === "loading") {
    return <p role="status" className="fa-hint">Loading the latest commits…</p>;
  }
  if (commits.status === "error") {
    return <Callout role="alert">{commits.message}</Callout>;
  }

  const { branch, limit, commits: list } = commits.data;
  const count = list.length;
  return (
    <section className="fa-repo-details__section" aria-labelledby="latest-commits-title">
      <div className="fa-repo-details__head">
        <h2 id="latest-commits-title" className="fa-section-title fa-section-title--large">
          Latest {count} {count === 1 ? "commit" : "commits"} on <code>{branch}</code>
        </h2>
        <p className="fa-hint">
          Up to {limit} commits, set by the <code>branch_commit_count</code> feature flag.
          {count > 0 && count < limit && ` This branch has ${count}.`}
        </p>
      </div>
      {count === 0 ? <p>This branch has no commits.</p> : <CommitList commits={list} branch={branch} />}
    </section>
  );
}

function CommitList({ commits, branch }: { commits: GitHubCommit[]; branch: string }) {
  const shown = commits.slice(0, SHOWN_COMMITS);
  const more = commits.slice(SHOWN_COMMITS);
  return (
    <>
      <ol className="fa-commits" aria-label={`Latest commits on ${branch}`}>
        {shown.map((commit) => <CommitRow key={commit.sha} commit={commit} />)}
      </ol>
      {more.length > 0 && (
        <details className="fa-disclosure">
          <summary>Show all {commits.length}</summary>
          <ol className="fa-commits" aria-label={`More commits on ${branch}`}>
            {more.map((commit) => <CommitRow key={commit.sha} commit={commit} />)}
          </ol>
        </details>
      )}
    </>
  );
}

function CommitRow({ commit }: { commit: GitHubCommit }) {
  return (
    <li className="fa-commit">
      <a className="fa-commit__sha" href={commit.url} target="_blank" rel="noreferrer">
        <code>{commit.sha.slice(0, 7)}</code>
      </a>
      <span className="fa-commit__message">{commit.message || "(no message)"}</span>
      <span className="fa-commit__who">
        <span>{commit.author}</span>
        <span>{formatDate(commit.date)}</span>
      </span>
    </li>
  );
}

function AnalyzeBar({ repoName, branch, subdir, commits, submitting, formError }: {
  repoName: string;
  branch: string;
  subdir: string;
  commits: RequestState<GitHubCommitList>;
  submitting: boolean;
  formError: string | null;
}) {
  const list = commits.status === "ready" ? commits.data.commits : null;
  const count = list?.length ?? 0;
  const folder = subdir.trim() ? displaySubdir(subdir.trim()) : "";
  const label = list ? `Analyze ${count} ${count === 1 ? "commit" : "commits"}` : "Analyze commits";

  return (
    <div className="fa-repo-details__bar">
      <div className="fa-repo-details__bar-inner">
        <div className="fa-repo-details__bar-text">
          <span className="fa-repo-details__bar-repo">{repoName}</span>
          <span className="fa-hint">
            <code>{branch}</code>
            {folder && <> · <code>{folder}</code></>}
          </span>
        </div>
        <div className="fa-repo-details__bar-action">
          {formError && <Callout role="alert">{formError}</Callout>}
          <Button type="submit" variant="primary" disabled={submitting || !list || count === 0}>
            {submitting ? "Starting analysis…" : label}
            <Icon name="arrow-right" size={16} />
          </Button>
        </div>
      </div>
    </div>
  );
}

// The import progress card (A4b). Once the import is ready the hook opens the flow view by itself;
// the Open link is there for a reviewer who does not want to wait.
function ImportCard({ repoName, branch, subdir, job, update, pollError, onRetry }: {
  repoName: string;
  branch: string;
  subdir: string;
  job: PickedImportJob;
  update: ImportStatus | undefined;
  pollError: string | null;
  onRetry: () => void;
}) {
  const { step, text, progress, warning } = importProgress(job.status, update);
  const ready = update?.status === "ready";
  const failed = Boolean(pollError) || update?.status === "error";
  const percent = ready ? 100 : progress ? Math.round((progress.current / progress.total) * 100) : null;
  const folder = subdir ? displaySubdir(subdir) : "";

  return (
    <Card padding="roomy" className="fa-analyzing">
      <div className="fa-analyzing__head">
        <span className="fa-analyzing__icon" aria-hidden="true">
          <Icon name="code" size={28} />
        </span>
        <h1>Import progress</h1>
        <p className="fa-hint">
          <strong>{repoName}</strong> · <code>{branch}</code>
          {folder && <> · <code>{folder}</code></>}
        </p>
      </div>
      {failed ? (
        <div className="fa-analyzing__failed">
          <Callout role="alert">{pollError || text}</Callout>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            Try again
          </Button>
        </div>
      ) : (
        <>
          <ol className="fa-analyzing__steps" aria-label="Import steps">
            {importSteps.map(({ label }, index) => {
              const state = index < step ? "done" : index === step ? "current" : "upcoming";
              return (
                <li
                  key={label}
                  className={`fa-analyzing__step fa-analyzing__step--${state}`}
                  aria-current={state === "current" ? "step" : undefined}
                >
                  <span className="fa-analyzing__marker">
                    {state === "done" ? <Icon name="check" size={15} /> : index + 1}
                  </span>
                  <span className="fa-analyzing__label">{label}</span>
                </li>
              );
            })}
          </ol>
          <div className="fa-analyzing__status">
            <div className="fa-analyzing__line">
              <span className="fa-analyzing__text" role="status">{text}</span>
              {percent !== null && <span className="fa-analyzing__percent">{percent}%</span>}
            </div>
            {percent !== null && (
              <div
                className="fa-analyzing__bar"
                role="progressbar"
                aria-label="Commits analyzed"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span className="fa-analyzing__bar-fill" style={{ width: `${percent}%` }} />
              </div>
            )}
            <div className="fa-analyzing__foot">
              <p className="fa-hint">
                {ready ? "Opening the flow in 2 seconds…" : update && `Elapsed time ${update.seconds.toFixed(1)} seconds`}
              </p>
              {ready && (
                <Button variant="primary" size="sm" to={repoPath(job.id)}>
                  Open
                  <Icon name="arrow-right" size={15} />
                </Button>
              )}
            </div>
            {warning && <p className="fa-hint" role="status">{warning}</p>}
          </div>
        </>
      )}
    </Card>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function cx(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
