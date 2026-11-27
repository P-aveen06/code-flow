import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGitHubBranches, fetchGitHubCommits, importPickedRepo } from "../api";
import { AppLink } from "../AppLink";
import { useBranchCommitCount } from "../flags";
import { pollRepoStatus } from "../pollRepoStatus";
import { githubRepoPath, githubReposPath, navigate, repoPath } from "../router";
import { resumeJourney, trackSignin, watchForAbandon } from "../signinEvents";
import type { GitHubCommitList, GitHubRepoChoice, ImportResponse, ImportStatus, PickedImportRequest } from "../types";
import { useRequest } from "../useRequest";
import { validateImport } from "./importHelpers";
import { ImportProgress } from "./ImportProgress";

type Job = ImportResponse & { body: PickedImportRequest };

export function GitHubRepoPage({ repoId, search }: { repoId: number; search: string }) {
  const commitCount = useBranchCommitCount(search);
  const loadBranches = useCallback((signal: AbortSignal) => fetchGitHubBranches(repoId, signal), [repoId]);
  const branches = useRequest(loadBranches);
  const requested = new URLSearchParams(search).get("branch");

  useEffect(() => resumeJourney(), []);
  useEffect(() => watchForAbandon(), []);

  return (
    <main className="github-page">
      <p><AppLink href={githubReposPath}>← Your repositories</AppLink></p>
      {branches.status === "loading" && <p role="status" className="card">Loading the repository…</p>}
      {branches.status === "error" && <p role="alert" className="card">{branches.message}</p>}
      {branches.status === "ready" && (
        <RepoDetails
          repo={branches.data.repo}
          branches={branches.data.branches}
          branch={requested && branches.data.branches.includes(requested) ? requested : branches.data.repo.default_branch}
          commitCount={commitCount}
        />
      )}
    </main>
  );
}

function RepoDetails({ repo, branches, branch, commitCount }: {
  repo: GitHubRepoChoice;
  branches: string[];
  branch: string;
  commitCount: { count: number; ready: boolean };
}) {
  const { count, ready } = commitCount;
  const loadCommits = useCallback(
    (signal: AbortSignal) => fetchGitHubCommits(repo.id, branch, count, signal),
    [repo.id, branch, count],
  );

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
          onChange={(event) => navigate(githubRepoPath(repo.id, event.target.value), { replace: true })}
        >
          {branches.map((name) => (
            <option key={name} value={name}>{name}{name === repo.default_branch ? " (default)" : ""}</option>
          ))}
        </select>
      </div>
      {ready
        ? <BranchCommits key={`${branch}:${count}`} repo={repo} branch={branch} loadCommits={loadCommits} />
        : <p role="status">Loading…</p>}
    </section>
  );
}

function BranchCommits({ repo, branch, loadCommits }: {
  repo: GitHubRepoChoice;
  branch: string;
  loadCommits: (signal: AbortSignal) => Promise<GitHubCommitList>;
}) {
  const commits = useRequest(loadCommits);
  const [subdir, setSubdir] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [update, setUpdate] = useState<ImportStatus>();
  const [pollError, setPollError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef<AbortController | null>(null);
  const busy = submitting || Boolean(job && !pollError && update?.status !== "error");

  useEffect(() => () => submission.current?.abort(), []);

  useEffect(() => {
    if (!job) return;
    const { id } = job;
    const controller = new AbortController();
    let navigationTimer: number | undefined;
    void pollRepoStatus(id, controller.signal, setUpdate).then(
      (status) => {
        if (controller.signal.aborted || status.status !== "ready") return;
        trackSignin("import_completed");
        navigationTimer = window.setTimeout(() => navigate(repoPath(id)), 2000);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setPollError(error instanceof Error ? error.message : "Could not check the import status.");
        }
      },
    );
    return () => {
      controller.abort();
      window.clearTimeout(navigationTimer);
    };
  }, [job]);

  async function start(body: PickedImportRequest) {
    if (submission.current) return;
    const controller = new AbortController();
    submission.current = controller;
    setSubmitting(true);
    setFormError(null);
    setJob(null);
    setUpdate(undefined);
    setPollError(null);
    try {
      const response = await importPickedRepo(body, controller.signal);
      if (!controller.signal.aborted) setJob({ ...response, body });
    } catch (error) {
      if (!controller.signal.aborted) {
        setFormError(error instanceof Error ? error.message : "Could not start the analysis.");
      }
    } finally {
      if (!controller.signal.aborted) {
        submission.current = null;
        setSubmitting(false);
      }
    }
  }

  function analyze(limit: number) {
    const result = validateImport({ url: `https://github.com/${repo.full_name}`, subdir, maxCommits: String(limit) });
    if (!("body" in result)) {
      setFormError(result.message);
      return;
    }
    trackSignin("repo_selected");
    void start({
      github_repo_id: repo.id, installation_id: repo.installation_id, branch,
      subdir: result.body.subdir, max_commits: result.body.max_commits,
    });
  }

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
      <form noValidate onSubmit={(event) => { event.preventDefault(); if (!busy) analyze(limit); }}>
        <fieldset disabled={busy || list.length === 0}>
          <div className="github-card__field">
            <label className="field__label" htmlFor="github-subdir">Subfolder (optional)</label>
            <input
              id="github-subdir" className="input" type="text" value={subdir}
              onChange={(event) => { setSubdir(event.target.value); setFormError(null); }}
            />
            <p className="muted field__hint">Only commits that change this folder are analyzed.</p>
          </div>
          {formError && <p role="alert">{formError}</p>}
          <button type="submit" className="btn btn--primary">
            {submitting ? "Starting analysis…" : `Analyze ${list.length} ${list.length === 1 ? "commit" : "commits"}`}
          </button>
        </fieldset>
      </form>
      {job && (
        <ImportProgress
          job={job} update={update} pollError={pollError}
          onRetry={() => {
            if (pollError) {
              setPollError(null);
              setJob({ ...job });
            } else void start(job.body);
          }}
        />
      )}
    </>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
