import { useCallback, useEffect, useState } from "react";
import { fetchHostedRepos, fetchRepos } from "../../api";
import type { Repo } from "../../types";
import { useRequest } from "../../useRequest";
import type { RequestState } from "../../useRequest";

// Sent when an import starts or finishes, so every landing list shows the change at once.
const reposChangedEvent = "code-flow:repos-changed";

export function announceReposChanged() {
  window.dispatchEvent(new Event(reposChangedEvent));
}

// The analyzed repositories on the landing. Reloads after an import changes and every 5 s
// while one runs; on the hosted demo it says the server is waking up after 3 s.
export function useLandingRepos(): { repos: RequestState<Repo[]>; waking: boolean; reload(): void } {
  const hosted = import.meta.env.VITE_HOSTED_DEMO === "1";
  const [revision, setRevision] = useState(0);
  const [waking, setWaking] = useState(false);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const loadRepos = useCallback((signal: AbortSignal) => (
    hosted ? fetchHostedRepos(signal) : fetchRepos(signal)
  ), [hosted, revision]);
  const repos = useRequest(loadRepos);

  useEffect(() => {
    window.addEventListener(reposChangedEvent, reload);
    return () => window.removeEventListener(reposChangedEvent, reload);
  }, [reload]);

  useEffect(() => {
    setWaking(false);
    if (!hosted || repos.status !== "loading") return;
    const timer = window.setTimeout(() => setWaking(true), 3000);
    return () => window.clearTimeout(timer);
  }, [hosted, loadRepos, repos.status]);

  useEffect(() => {
    if (repos.status !== "ready" || repos.data.every(({ status }) => status === "ready" || status === "error")) return;
    const timer = window.setTimeout(() => reload(), 5000);
    return () => window.clearTimeout(timer);
  }, [repos, reload]);

  return { repos, waking, reload };
}
