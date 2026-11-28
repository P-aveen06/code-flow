import { AppLink } from "../AppLink";
import { useRepoDetails } from "../appFlow/hooks/useRepoDetails";
import { githubReposPath } from "../router";
import type { GitHubRepoChoice } from "../types";
import { ImportProgress } from "./ImportProgress";

type RepoDetails = ReturnType<typeof useRepoDetails>;

export function GitHubRepoPage({ repoId, search }: { repoId: number; search: string }) {
  const details = useRepoDetails(repoId, search);
  const { branches } = details;

  return (
    <main className="github-page">
      <p><AppLink href={githubReposPath}>← Your repositories</AppLink></p>
      {branches.status === "loading" && <p role="status" className="card">Loading the repository…</p>}
      {branches.status === "error" && <p role="alert" className="card">{branches.message}</p>}
      {branches.status === "ready" && (
        <RepoDetailsCard repo={branches.data.repo} branches={branches.data.branches} details={details} />
      )}
    </main>
  );
}

function RepoDetailsCard({ repo, branches, details }: {
  repo: GitHubRepoChoice;
  branches: string[];
  details: RepoDetails;
}) {
  const { branch, setBranch, commitCount } = details;

  return (
    <section className="card github-card" aria-labelledby="github-repo-title">
      <h1 id="github-repo-title">
        {repo.full_name}
        {repo.private && <span className="status-chip repo-private">Private</span>}
      </h1>
      {repo.private && <p className="muted">Private: only you will see what you analyze here.</p>}
      <div className="github-card__field">
        <label className="field__label" htmlFor="github-branch">Branch</label>
        <select
          id="github-branch" className="input" value={branch}
          onChange={(event) => setBranch(event.target.value)}
        >
          {branches.map((name) => (
            <option key={name} value={name}>{name}{name === repo.default_branch ? " (default)" : ""}</option>
          ))}
        </select>
      </div>
      {commitCount.ready
        ? <BranchCommits details={details} />
        : <p role="status">Loading…</p>}
    </section>
  );
}

function BranchCommits({ details }: { details: RepoDetails }) {
  const { commits, subdir, setSubdir, formError, analyze, busy, submitting, job, update, pollError, retry } = details;

  if (commits.status === "loading") return <p role="status">Loading the latest commits…</p>;
  if (commits.status === "error") return <p role="alert">{commits.message}</p>;
  const { limit, commits: list } = commits.data;

  return (
    <>
      <h2 className="github-card__subtitle">
        Latest {list.length} {list.length === 1 ? "commit" : "commits"} on <code>{commits.data.branch}</code>
      </h2>
      <p className="muted field__hint">
        Up to {limit} commits, set by the <code>branch_commit_count</code> feature flag.
        {list.length < limit && list.length > 0 && ` This branch has ${list.length}.`}
      </p>
      {list.length === 0 ? <p>This branch has no commits.</p> : (
        <ol className="branch-commits" aria-label={`Latest commits on ${commits.data.branch}`}>
          {list.map((commit) => (
            <li key={commit.sha}>
              <a href={commit.url} target="_blank" rel="noreferrer"><code>{commit.sha.slice(0, 7)}</code></a>
              <span className="branch-commits__message">{commit.message || "(no message)"}</span>
              <span className="muted">{[commit.author, formatDate(commit.date)].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ol>
      )}
      <form noValidate onSubmit={(event) => { event.preventDefault(); analyze(); }}>
        <fieldset disabled={busy || list.length === 0}>
          <div className="github-card__field">
            <label className="field__label" htmlFor="github-subdir">Subfolder (optional)</label>
            <input
              id="github-subdir" className="input" type="text" value={subdir}
              onChange={(event) => setSubdir(event.target.value)}
            />
            <p className="muted field__hint">Only commits that change this folder are analyzed.</p>
          </div>
          {formError && <p role="alert">{formError}</p>}
          <button type="submit" className="btn btn--primary">
            {submitting ? "Starting analysis…" : `Analyze ${list.length} ${list.length === 1 ? "commit" : "commits"}`}
          </button>
        </fieldset>
      </form>
      {job && <ImportProgress job={job} update={update} pollError={pollError} onRetry={retry} />}
    </>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
