import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGitHubBranches, fetchGitHubCommits, importPickedRepo } from "../../api";
import { useBranchCommitCount } from "../../flags";
import { validateImport } from "../../pages/importHelpers";
import { pollRepoStatus } from "../../pollRepoStatus";
import { githubRepoPath, navigate, repoPath } from "../../router";
import { resumeJourney, trackSignin, watchForAbandon } from "../../signinEvents";
import type { GitHubBranches, GitHubCommitList, ImportResponse, ImportStatus, PickedImportRequest } from "../../types";
import { useRequest } from "../../useRequest";
import type { RequestState } from "../../useRequest";

export type PickedImportJob = ImportResponse & { body: PickedImportRequest };
// Never settles, so useRequest stays "loading" and nothing is fetched.
const notStarted = new Promise<never>(() => {});

// A GitHub repository's page: its branches, the latest commits of the chosen branch (the
// branch_commit_count flag decides how many) and the analysis of that branch.
export function useRepoDetails(repoId: number, search: string) {
  const commitCount = useBranchCommitCount(search);
  const loadBranches = useCallback((signal: AbortSignal) => fetchGitHubBranches(repoId, signal), [repoId]);
  const branches: RequestState<GitHubBranches> = useRequest(loadBranches);
  const requested = new URLSearchParams(search).get("branch");
  const branch = branches.status === "ready"
    ? (requested && branches.data.branches.includes(requested) ? requested : branches.data.repo.default_branch)
    : "";
  const { count, ready: countReady } = commitCount;
  // The commits wait for the branch list and the commit count, as the page did before.
  const listReady = branches.status === "ready" && countReady;
  const loadCommits = useCallback(
    (signal: AbortSignal) => (listReady ? fetchGitHubCommits(repoId, branch, count, signal) : notStarted),
    [listReady, repoId, branch, count],
  );
  const commits: RequestState<GitHubCommitList> = useRequest(loadCommits);

  const [subdir, setSubdirValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [job, setJob] = useState<PickedImportJob | null>(null);
  const [update, setUpdate] = useState<ImportStatus>();
  const [pollError, setPollError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef<AbortController | null>(null);
  const busy = submitting || Boolean(job && !pollError && update?.status !== "error");

  // The analysis form starts afresh for each branch and commit count, as its markup used to remount.
  const scope = listReady ? `${repoId}:${branch}:${count}` : "";
  const [formScope, setFormScope] = useState(scope);
  if (formScope !== scope) {
    setFormScope(scope);
    setSubdirValue("");
    setFormError(null);
    setJob(null);
    setUpdate(undefined);
    setPollError(null);
    setSubmitting(false);
  }

  useEffect(() => () => {
    submission.current?.abort();
    submission.current = null;
  }, [scope]);

  useEffect(() => resumeJourney(), []);
  useEffect(() => watchForAbandon(), []);

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

  function setSubdir(value: string) {
    setSubdirValue(value);
    setFormError(null);
  }

  // Changing the branch replaces the URL, as the branch select always did.
  function setBranch(name: string) {
    navigate(githubRepoPath(repoId, name), { replace: true });
  }

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

  // Analyzes the latest commits of the branch, up to the number the list shows.
  function analyze() {
    if (busy || branches.status !== "ready" || commits.status !== "ready") return;
    const { repo } = branches.data;
    const result = validateImport({
      url: `https://github.com/${repo.full_name}`, subdir, maxCommits: String(commits.data.limit),
    });
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

  // Try again: poll the same analysis after a failed check, or start it again.
  function retry() {
    if (!job) return;
    if (pollError) {
      setPollError(null);
      setJob({ ...job });
    } else void start(job.body);
  }

  return {
    branches, branch, setBranch, commitCount, commits, subdir, setSubdir, formError, analyze,
    submitting, busy, job, update, pollError, retry,
  };
}
