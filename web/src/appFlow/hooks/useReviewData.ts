import { useCallback } from "react";
import { fetchCommits, fetchRepos, fetchSnapshot } from "../../api";
import type { TimelineCommit } from "../../types";
import { useRequest } from "../../useRequest";
import type { RequestState } from "../../useRequest";

async function hasNonemptySnapshot(id: string, commits: TimelineCommit[], signal: AbortSignal) {
  // An addition or change proves that the commit's own snapshot contains nodes.
  if (commits.some(({ stats }) => stats.nodes_added > 0 || stats.nodes_changed > 0)) return true;
  // With no additions, later first-parent snapshots can only keep or remove the oldest snapshot's nodes.
  const first = commits[0];
  if (!first) return false;
  const snapshot = await fetchSnapshot(id, first.sha, signal);
  return snapshot.nodes.length > 0;
}

export async function loadReview(id: string, signal: AbortSignal) {
  const [history, repos] = await Promise.all([fetchCommits(id, signal), fetchRepos(signal)]);
  const repo = repos.find((entry) => entry.id === id);
  const hasNodes = await hasNonemptySnapshot(id, history.commits, signal);
  return {
    commits: history.commits, name: repo?.name ?? history.repo, subdir: repo?.subdir ?? null,
    url: repo?.url ?? null, branch: repo?.branch ?? "", hasNodes,
  };
}

export type ReviewData = Awaited<ReturnType<typeof loadReview>>;

// The commit history and repo details a review page starts from.
export function useReviewData(id: string): RequestState<ReviewData> {
  const request = useCallback((signal: AbortSignal) => loadReview(id, signal), [id]);
  return useRequest(request);
}
