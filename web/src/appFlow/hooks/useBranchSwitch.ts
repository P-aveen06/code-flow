// The data behind the branch switch that every flow view shows: the branches of an import, the
// latest commits of one, and analyzing it, or opening an analysis that already exists.
// See docs/APP_FLOW_BUILD.md, "Branch switch contract" and "Shared data hooks".
import { useEffect, useRef, useState } from "react";
import {
  fetchGitHubRepos, fetchMe, fetchRepoBranchCommits, fetchRepoBranches, importRepoBranch,
} from "../../api";
import { useBranchCommitCount } from "../../flags";
import { importProgress } from "../../pages/importHelpers";
import { pollRepoStatus } from "../../pollRepoStatus";
import { navigate, repoPath } from "../../router";
import type { GitHubCommitList, ImportStatus, RepoBranches } from "../../types";
import type { RequestState } from "../../useRequest";
import { markBranchSwitchOpened } from "../journey";

export interface BranchSwitch {
  info: RequestState<RepoBranches>;
  selected: string | null;
  select(name: string): void;
  commits: RequestState<GitHubCommitList>;
  analyze(): void;
  progress: { text: string; current: number; total: number } | null;
  error: string | null;
  githubRepoId: number | null;
}

// An analysis started from the switch. `id` is set once the server has accepted it.
interface Analysis {
  repoId: string;
  id?: string;
  update?: ImportStatus;
}

export function useBranchSwitch(repoId: string, open: boolean): BranchSwitch {
  const { count, ready } = useBranchCommitCount(window.location.search);
  const [opened, setOpened] = useState(false);
  const [picked, setPicked] = useState<{ repoId: string; branch: string }>();
  const [analysis, setAnalysis] = useState<Analysis>();
  const [failure, setFailure] = useState<{ repoId: string; message: string }>();
  const submission = useRef<AbortController | null>(null);

  // Only the first opening counts. The branches stay loaded after the switch closes.
  useEffect(() => {
    if (!open || opened) return;
    markBranchSwitchOpened();
    setOpened(true);
  }, [open, opened]);

  // A request to start an analysis that is still waiting is dropped when the page goes away.
  useEffect(() => () => submission.current?.abort(), []);

  const info = useKeyedRequest(opened ? { repoId } : null, ({ repoId: id }, signal) =>
    fetchRepoBranches(id, signal));
  const selected = picked?.repoId === repoId ? picked.branch : null;
  const commits = useKeyedRequest(
    selected !== null && ready ? { repoId, branch: selected, count } : null,
    ({ repoId: id, branch, count: limit }, signal) => fetchRepoBranchCommits(id, branch, limit, signal),
  );
  const githubRepo = useKeyedRequest(
    info.status === "ready" ? { fullName: info.data.full_name } : null,
    ({ fullName }, signal) => findGitHubRepoId(fullName, signal),
  );

  // An analysis belongs to the repo it started for. Another repo's is not shown here.
  const running = analysis?.repoId === repoId ? analysis : undefined;
  const runningId = running?.id;

  // Poll the analysis until it finishes. Leaving the repo stops the polling.
  useEffect(() => {
    if (runningId === undefined) return;
    const controller = new AbortController();
    pollRepoStatus(runningId, controller.signal, (update) => {
      setAnalysis((latest) => (latest?.id === runningId ? { ...latest, update } : latest));
    }).then(
      (status) => {
        if (controller.signal.aborted) return;
        setAnalysis((latest) => (latest?.id === runningId ? undefined : latest));
        if (status.status === "ready") navigate(repoPath(runningId));
        else setFailure({ repoId, message: status.error || status.message });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setAnalysis((latest) => (latest?.id === runningId ? undefined : latest));
        setFailure({ repoId, message: messageOf(error) });
      },
    );
    return () => controller.abort();
  }, [runningId, repoId]);

  function select(name: string) {
    setPicked({ repoId, branch: name });
    setFailure(undefined);
  }

  function analyze() {
    if (selected === null || commits.status !== "ready" || running !== undefined) return;
    const branch = selected;
    // A ready import of this branch opens at once, without another analysis.
    const existing = info.status === "ready"
      ? info.data.analyzed.find((item) => item.branch === branch)
      : undefined;
    if (existing?.status === "ready") {
      navigate(repoPath(existing.id));
      return;
    }
    submission.current?.abort();
    const controller = new AbortController();
    submission.current = controller;
    setFailure(undefined);
    setAnalysis({ repoId });
    // The commit count the server used, which is the flag's count lowered to the import cap.
    importRepoBranch(repoId, { branch, max_commits: commits.data.limit }, controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) setAnalysis({ repoId, id: response.id });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setAnalysis(undefined);
        setFailure({ repoId, message: messageOf(error) });
      },
    );
  }

  return {
    info,
    selected,
    select,
    commits,
    analyze,
    progress: running ? progressOf(running) : null,
    error: failure?.repoId === repoId ? failure.message : null,
    githubRepoId: githubRepo.status === "ready" ? githubRepo.data : null,
  };
}

// Runs `load(key)` whenever the key changes, and keeps the result for that key. A null key loads
// nothing and reports loading.
function useKeyedRequest<K, T>(
  key: K | null,
  load: (key: K, signal: AbortSignal) => Promise<T>,
): RequestState<T> {
  const id = key === null ? null : JSON.stringify(key);
  const [result, setResult] = useState<{ id: string; state: RequestState<T> }>();

  useEffect(() => {
    if (key === null || id === null) return;
    const controller = new AbortController();
    load(key, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ id, state: { status: "ready", data } });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ id, state: { status: "error", message: messageOf(error) } });
        }
      },
    );
    return () => controller.abort();
  }, [id]);

  return id !== null && result?.id === id ? result.state : { status: "loading" };
}

// The GitHub repo ID of this import, for a signed-in visitor who can see the repo. Otherwise null.
async function findGitHubRepoId(fullName: string, signal: AbortSignal): Promise<number | null> {
  try {
    const me = await fetchMe(signal);
    if (!me.signed_in) return null;
    const wanted = fullName.toLowerCase();
    const repos = await fetchGitHubRepos(signal);
    return repos.find((repo) => repo.full_name.toLowerCase() === wanted)?.id ?? null;
  } catch {
    return null;
  }
}

function progressOf(analysis: Analysis) {
  if (analysis.id === undefined) return { text: "Starting analysis…", current: 0, total: 0 };
  const { text, progress } = importProgress("queued", analysis.update);
  return { text, current: progress?.current ?? 0, total: progress?.total ?? 0 };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
