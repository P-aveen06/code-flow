import { apiUrl } from "./config";
import { waitFor } from "./waitFor";
import type {
  CodeSnippet, CommitList, DiffViewModel, FunctionDiff, GitHubBranches, GitHubCommitList, GitHubRepoChoice,
  GraphSnapshot, ImportRequest,
  ImportResponse, ImportStatus, Me, PickedImportRequest, Repo, RepoBranches, RepoFlags,
} from "./types";

// The server refuses session POSTs without this header, so other sites cannot forge them.
const csrfHeader = { "X-Requested-With": "code-flow" };

function apiBase() {
  return apiUrl.replace(/\/+$/, "");
}

class HttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Server returned HTTP ${status}${detail}`);
  }
}

async function requestJson<T>(path: string, signal?: AbortSignal, options?: RequestInit): Promise<T> {
  let response: Response;
  const headers = options?.method === "POST" ? { ...csrfHeader, ...options.headers } : options?.headers;
  try {
    response = await fetch(`${apiBase()}/api${path}`, { ...options, headers, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(apiBase() ? `Cannot reach the code-flow server at ${apiUrl}.` : "Cannot reach the code-flow server.");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    // POSTs and the GitHub routes explain themselves, so show their message as it is.
    const plain = options?.method === "POST" || path.startsWith("/github/");
    if ([400, 401, 404, 409].includes(response.status) && plain && typeof body?.detail === "string") {
      throw new Error(body.detail);
    }
    const detail = typeof body?.detail === "string" ? `: ${body.detail}` : "";
    throw new HttpError(response.status, detail);
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

export async function fetchHostedRepos(signal: AbortSignal): Promise<Repo[]> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(75_000)]);
  try {
    for (const delay of [2_000, 5_000, 15_000, 38_000]) {
      try {
        return await fetchRepos(requestSignal);
      } catch (error) {
        if (error instanceof HttpError && error.status < 500) throw error;
      }
      await waitFor(delay, requestSignal);
    }
    return await fetchRepos(requestSignal);
  } catch (error) {
    if (requestSignal.aborted && !signal.aborted) {
      throw new Error("The demo server took too long to wake up. Reload the page to try again.");
    }
    throw error;
  }
}

export function signInUrl() {
  return `${apiBase()}/api/auth/github/login`;
}

export async function fetchMe(signal?: AbortSignal): Promise<Me> {
  const me = await requestJson<Partial<Me>>("/me", signal, { cache: "no-store" });
  if (me?.signed_in === true) return me as Me;
  return { configured: me?.configured === true, signed_in: false };
}

export function fetchGitHubRepos(signal?: AbortSignal) {
  return requestJson<GitHubRepoChoice[]>("/github/repos", signal, { cache: "no-store" });
}

export function fetchGitHubBranches(repoId: number, signal?: AbortSignal) {
  return requestJson<GitHubBranches>(`/github/repos/${repoId}/branches`, signal, { cache: "no-store" });
}

export function fetchGitHubCommits(repoId: number, branch: string, limit: number, signal?: AbortSignal) {
  const query = new URLSearchParams({ branch, limit: String(limit) });
  return requestJson<GitHubCommitList>(`/github/repos/${repoId}/commits?${query}`, signal, { cache: "no-store" });
}

export async function signOut() {
  const response = await fetch(`${apiBase()}/api/auth/logout`, { method: "POST", headers: csrfHeader });
  if (!response.ok) throw new Error("Could not sign out. Try again.");
}

export function importPickedRepo(body: PickedImportRequest, signal?: AbortSignal) {
  return requestJson<ImportResponse>("/repos", signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  return requestJson<ImportStatus>(`${repoPath(id)}/status`, signal, { cache: "no-store" });
}

export function refreshRepo(id: string, signal?: AbortSignal) {
  return requestJson<ImportResponse>(`${repoPath(id)}/refresh`, signal, { method: "POST" });
}

export function fetchCommits(repo: string, signal?: AbortSignal) {
  return requestJson<CommitList>(`${repoPath(repo)}/commits`, signal);
}

export function fetchSnapshot(repo: string, sha: string, signal?: AbortSignal) {
  return requestJson<GraphSnapshot>(`${repoPath(repo)}/snapshots/${encodeURIComponent(sha)}`, signal);
}

export async function fetchRepoFlags(repo: string, sha?: string, signal?: AbortSignal) {
  const query = sha ? `?${new URLSearchParams({ sha })}` : "";
  try {
    return await requestJson<RepoFlags>(`${repoPath(repo)}/flags${query}`, signal, { cache: "no-store" });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new Error("Flagsmith findings are unavailable for this commit (HTTP 404).");
    }
    throw error;
  }
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

export function fetchFunctionDiff(repo: string, head: string, node: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ head, node });
  return requestJson<FunctionDiff>(`${repoPath(repo)}/function-diff?${query}`, signal);
}

// Branches of an imported GitHub repository, for the branch switch in a flow view.
export function fetchRepoBranches(repoId: string, signal?: AbortSignal) {
  return requestJson<RepoBranches>(`${repoPath(repoId)}/branches`, signal, { cache: "no-store" });
}

export function fetchRepoBranchCommits(repoId: string, branch: string, limit: number, signal?: AbortSignal) {
  const query = new URLSearchParams({ branch, limit: String(limit) });
  return requestJson<GitHubCommitList>(`${repoPath(repoId)}/branches/commits?${query}`, signal, { cache: "no-store" });
}

export function importRepoBranch(repoId: string, body: { branch: string; max_commits: number }, signal?: AbortSignal) {
  return requestJson<ImportResponse>(`${repoPath(repoId)}/branches`, signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
