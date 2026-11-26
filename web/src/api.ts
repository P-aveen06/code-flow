import { apiUrl } from "./config";
import type {
  CodeSnippet, CommitList, DiffViewModel, GraphSnapshot, ImportRequest, ImportResponse,
  ImportStatus, Repo,
} from "./types";

async function requestJson<T>(path: string, signal?: AbortSignal, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api${path}`, { ...options, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Cannot reach the code-flow server at ${apiUrl}.`);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 400 && options?.method === "POST" && typeof body?.detail === "string") {
      throw new Error(body.detail);
    }
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

export async function fetchRepos(signal?: AbortSignal): Promise<Repo[]> {
  type LegacyRepo = Pick<Repo, "name" | "branch" | "commit_count">;
  const repos = await requestJson<(Repo | LegacyRepo)[]>("/repos", signal);
  // M2 lists local repositories by name and only returns completed analyses.
  return repos.map((repo) => "id" in repo ? repo : {
    ...repo, id: repo.name, url: null, subdir: null, status: "ready", message: "Ready", warning: null,
  });
}

export function importRepo(body: ImportRequest, signal?: AbortSignal) {
  return requestJson<ImportResponse>("/repos", signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function fetchRepoStatus(id: string, signal?: AbortSignal) {
  return requestJson<ImportStatus>(`${repoPath(id)}/status`, signal);
}

export function fetchCommits(repo: string, signal?: AbortSignal) {
  return requestJson<CommitList>(`${repoPath(repo)}/commits`, signal);
}

export function fetchSnapshot(repo: string, sha: string, signal?: AbortSignal) {
  return requestJson<GraphSnapshot>(`${repoPath(repo)}/snapshots/${encodeURIComponent(sha)}`, signal);
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
  return requestJson<DiffViewModel>(`${repoPath(repo)}/diff?${query}`, signal);
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
  return requestJson<CodeSnippet>(`${repoPath(repo)}/code?${query}`, signal);
}
