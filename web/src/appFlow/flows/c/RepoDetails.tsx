// Flow C "Canvas": repo details (C4) and the analysis of a branch (C4b). The branches are pills, the
// latest commits sit on a rail, and the analysis runs in a floating card beside the rail, which fills
// in as commits are analysed. useRepoDetails opens the flow view itself once the import is ready.
import { useId } from "react";
import { importProgress, importSteps } from "../../../pages/importHelpers";
import { githubReposPath, navigate, repoPath } from "../../../router";
import type { GitHubCommit, GitHubRepoChoice } from "../../../types";
import { useMe } from "../../hooks/useMe";
import { useRepoDetails } from "../../hooks/useRepoDetails";
import { Button } from "../../ui/Button";
import { AvatarMenu, CanvasBackground, FloatingPanel, Header, Icon, Pill } from "./kit";
import "./repos.css";

type Details = ReturnType<typeof useRepoDetails>;
type Job = NonNullable<Details["job"]>;

export function RepoDetailsC({ repoId, search }: { repoId: number; search: string }) {
  const details = useRepoDetails(repoId, search);
  const { me, signOut } = useMe();

  return (
    <>
      <Header
        right={me.status === "ready"
          ? <AvatarMenu me={me.data} onSignOut={() => { void signOut().finally(() => navigate("/")); }} />
          : undefined}
      />
      <main className="fc-repo-details">
        <Band details={details} />
        <CanvasBackground className="fc-repo-details__canvas">
          {details.branches.status === "ready" && <Body details={details} />}
        </CanvasBackground>
      </main>
    </>
  );
}

// The white band at the top: the way back, the repository, its branches and the analyze form.
function Band({ details }: { details: Details }) {
  const { branches } = details;
  return (
    <section className="fc-repo-details__band">
      <Button variant="tertiary" size="sm" to={githubReposPath} className="fc-repo-details__back">
        <Icon name="arrow-left" size={16} />
        Your repositories
      </Button>
      {branches.status === "loading" && <p role="status" className="fc-repo-details__status">Loading the repository…</p>}
      {branches.status === "error" && <p role="alert" className="fc-repo-details__alert">{branches.message}</p>}
      {branches.status === "ready" && (
        <RepoHead repo={branches.data.repo} branches={branches.data.branches} details={details} />
      )}
    </section>
  );
}

function RepoHead({ repo, branches, details }: {
  repo: GitHubRepoChoice;
  branches: string[];
  details: Details;
}) {
  const { branch, setBranch, commitCount, commits, subdir, setSubdir, formError, analyze, busy, submitting, update } = details;
  const hintId = useId();
  const listed = commits.status === "ready" ? commits.data.commits.length : commitCount.count;
  const limit = commits.status === "ready" ? commits.data.limit : commitCount.count;
  const canAnalyze = commits.status === "ready" && listed > 0;
  const buttonState = submitting ? "Starting analysis…" : update?.status === "ready" ? "Ready" : busy ? "Analyzing…" : null;

  return (
    <div className="fc-repo-details__head">
      <div className="fc-repo-details__heading">
        <div className="fc-repo-details__name-row">
          <h1 className="fc-repo-details__name">{repo.full_name}</h1>
          {repo.private && (
            <Pill>
              <Icon name="lock" size={13} />
              Private
            </Pill>
          )}
        </div>
        {repo.private && <p className="fc-repo-details__note">Private: only you will see what you analyze here.</p>}
        <div role="group" aria-label="Branches" className="fc-repo-details__branches">
          {branches.map((name) => {
            const selected = name === branch;
            return (
              <Button
                key={name}
                size="sm"
                aria-pressed={selected}
                onClick={() => setBranch(name)}
                className={cx("fc-repo-details__branch", selected && "fc-repo-details__branch--selected")}
              >
                <code>{name}</code>
                {name === repo.default_branch && <span className="fc-repo-details__default">· default</span>}
              </Button>
            );
          })}
        </div>
        <p className="fc-repo-details__hint">
          Up to {limit} commits, set by the <code>branch_commit_count</code> feature flag.
          {commits.status === "ready" && listed > 0 && listed < limit && ` This branch has ${listed}.`}
        </p>
      </div>
      <form
        className="fc-repo-details__form"
        onSubmit={(event) => {
          event.preventDefault();
          analyze();
        }}
      >
        <div className="fc-repo-details__form-row">
          <label className="fc-repo-details__field">
            <span className="fc-repo-details__label">Subfolder (optional)</span>
            <input
              type="text"
              className="fc-repo-details__input"
              value={subdir}
              placeholder="api/"
              aria-describedby={hintId}
              onChange={(event) => setSubdir(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy || !canAnalyze}>
            {buttonState ?? (
              <>
                Analyze {counted(listed, "commit")}
                <Icon name="arrow-right" size={16} />
              </>
            )}
          </Button>
        </div>
        <p id={hintId} className="fc-repo-details__hint">Only commits that change this folder are analyzed.</p>
        {formError && <p role="alert" className="fc-repo-details__alert">{formError}</p>}
      </form>
    </div>
  );
}

// The commits of the branch, and beside them the analysis once one has started.
function Body({ details }: { details: Details }) {
  const { job, update, pollError, retry } = details;
  return (
    <div className={cx("fc-repo-details__body", job && "fc-repo-details__body--analysing")}>
      <Commits details={details} />
      {job && <Analysis job={job} update={update} pollError={pollError} onRetry={retry} />}
    </div>
  );
}

function Commits({ details }: { details: Details }) {
  const { commits, job, update } = details;
  if (commits.status === "loading") {
    return (
      <section className="fc-repo-details__commits">
        <p role="status" className="fc-repo-details__status">Loading the latest commits…</p>
      </section>
    );
  }
  if (commits.status === "error") {
    return (
      <section className="fc-repo-details__commits">
        <p role="alert" className="fc-repo-details__alert">{commits.message}</p>
      </section>
    );
  }
  const { branch, commits: list } = commits.data;
  const analysed = analysedCount(job, update, list.length);
  return (
    <section className="fc-repo-details__commits">
      {list.length === 0 ? (
        <>
          <h2 className="fc-repo-details__section-title">Latest commits on <code>{branch}</code></h2>
          <p className="fc-repo-details__status">This branch has no commits.</p>
        </>
      ) : (
        <>
          <h2 className="fc-repo-details__section-title">
            Latest {list.length} {list.length === 1 ? "commit" : "commits"} on <code>{branch}</code>
          </h2>
          <ol className="fc-repo-details__rail" aria-label={`Latest commits on ${branch}`}>
            {list.map((commit, index) => (
              <CommitRow key={commit.sha} commit={commit} filled={index < analysed} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function CommitRow({ commit, filled }: { commit: GitHubCommit; filled: boolean }) {
  return (
    <li className="fc-repo-details__commit">
      <span className="fc-repo-details__dot-slot" aria-hidden="true">
        <span className={cx("fc-repo-details__dot", filled && "fc-repo-details__dot--filled")} />
      </span>
      <div className="fc-repo-details__row">
        <a className="fc-repo-details__sha" href={commit.url} target="_blank" rel="noreferrer">
          <code>{commit.sha.slice(0, 7)}</code>
        </a>
        <p className="fc-repo-details__message" title={commit.message}>{commit.message || "(no message)"}</p>
        <span className="fc-repo-details__meta">{commit.author}</span>
        <span className="fc-repo-details__date">{formatDate(commit.date)}</span>
      </div>
    </li>
  );
}

// The rail fills in as commits are analysed: all of them once the import is ready.
function analysedCount(job: Job | null, update: Details["update"], total: number): number {
  if (!job) return 0;
  return update?.status === "ready" ? total : (update?.current ?? 0);
}

// The analysis of the branch: a floating status pill and a card with the steps, the progress bar
// and, when ready, the way into the flow view. A failed check or import offers to try again.
function Analysis({ job, update, pollError, onRetry }: {
  job: Job;
  update: Details["update"];
  pollError: string | null;
  onRetry: () => void;
}) {
  const { step, text, progress, warning } = importProgress(job.status, update);
  const ready = update?.status === "ready";
  const failed = Boolean(pollError) || update?.status === "error";
  const percent = ready ? 100 : progress ? Math.round((progress.current / progress.total) * 100) : 0;
  const seconds = update ? update.seconds.toFixed(1) : null;

  return (
    <div className="fc-repo-details__side">
      {!failed && !ready && (
        <div className="fc-repo-details__pill" aria-hidden="true">
          <span className="fc-repo-details__pulse" />
          {text}
          {seconds && ` · ${seconds} s`}
        </div>
      )}
      <FloatingPanel className="fc-repo-details__analysis">
        <ol className="fc-repo-details__steps" aria-label="Import steps">
          {importSteps.map(({ status, label }, index) => {
            const done = ready || index < step;
            return (
              <li
                key={status}
                className="fc-repo-details__step"
                aria-current={index === step ? "step" : undefined}
                data-complete={done}
              >
                <span className="fc-repo-details__mark" aria-hidden="true">
                  {done ? <Icon name="check" size={12} /> : <span className="fc-repo-details__mini-dot" />}
                </span>
                {label}
                {index < importSteps.length - 1 && <Icon name="arrow-right" size={12} />}
              </li>
            );
          })}
        </ol>
        {failed ? (
          <>
            <p role="alert" className="fc-repo-details__alert">{pollError || text}</p>
            <Button variant="primary" onClick={() => onRetry()}>Try again</Button>
          </>
        ) : (
          <>
            <div className="fc-repo-details__status-row">
              <div role="status" className="fc-repo-details__status-text">
                <h3 className="fc-repo-details__status-title">{ready ? "Ready" : text}</h3>
                <p className="fc-repo-details__muted">
                  {ready ? "Opening the flow view in 2 seconds…" : seconds && `Elapsed time ${seconds} seconds`}
                </p>
              </div>
              {ready && (
                <Button variant="primary" to={repoPath(job.id)}>
                  Open
                  <Icon name="arrow-right" size={16} />
                </Button>
              )}
            </div>
            <div
              className="fc-repo-details__progress"
              role="progressbar"
              aria-label="Analysis progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="fc-repo-details__progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </>
        )}
        {warning && <p role="status" className="fc-repo-details__muted">{warning}</p>}
      </FloatingPanel>
    </div>
  );
}

function counted(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
