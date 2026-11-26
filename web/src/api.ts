import { apiUrl } from "./config";
import type { CodeSnippet, CommitList, DiffViewModel, Repo } from "./types";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api${path}`, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Cannot reach the code-flow server at ${apiUrl}.`);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? `: ${body.detail}` : "";
    throw new Error(`Server returned HTTP ${response.status}${detail}`);
  }

  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("The code-flow server returned invalid JSON.");
  }
}

function repoPath(repo: string): string {
  return `/repos/${encodeURIComponent(repo)}`;
}

export function fetchRepos(signal?: AbortSignal) {
  return getJson<Repo[]>("/repos", signal);
}

export function fetchCommits(repo: string, signal?: AbortSignal) {
  return getJson<CommitList>(`${repoPath(repo)}/commits`, signal);
}

export function fetchDiff(
  repo: string,
  head: string,
  options: { base?: string; hops?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ head });
  if (options.base !== undefined) query.set("base", options.base);
  if (options.hops !== undefined) query.set("hops", String(options.hops));
  return getJson<DiffViewModel>(`${repoPath(repo)}/diff?${query}`, signal);
}

export function fetchCode(
  repo: string,
  sha: string,
  file: string,
  start?: number,
  end?: number,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ sha, file });
  if (start !== undefined) query.set("start", String(start));
  if (end !== undefined) query.set("end", String(end));
  return getJson<CodeSnippet>(`${repoPath(repo)}/code?${query}`, signal);
}
