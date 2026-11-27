import { useSyncExternalStore } from "react";

type Route =
  | { page: "landing" }
  | { page: "viewer"; id: string }
  | { page: "github-repos" }
  | { page: "github-repo"; repoId: number }
  | { page: "not-found" };

function validRepoId(id: string) {
  return id.length > 0 && !id.includes("..") && !/[\/\\]/.test(id) && id !== ".";
}

export function parsePath(pathname: string): Route {
  if (pathname === "/") return { page: "landing" };
  if (/^\/github\/?$/.test(pathname)) return { page: "github-repos" };
  const github = /^\/github\/([1-9]\d{0,15})\/?$/.exec(pathname);
  if (github) return { page: "github-repo", repoId: Number(github[1]) };
  const match = /^\/repo\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    try {
      const id = decodeURIComponent(match[1]);
      if (validRepoId(id)) return { page: "viewer", id };
    } catch {
      // Malformed URL encoding is an unknown route.
    }
  }
  return { page: "not-found" };
}

export function repoPath(id: string): string {
  return `/repo/${encodeURIComponent(id)}`;
}

export const githubReposPath = "/github";

export function githubRepoPath(repoId: number, branch?: string): string {
  return `${githubReposPath}/${repoId}${branch ? `?${new URLSearchParams({ branch })}` : ""}`;
}

export function legacyRepoRedirect(pathname: string, search: string): string | null {
  if (pathname !== "/") return null;
  const params = new URLSearchParams(search);
  const id = params.get("repo");
  if (!id || !validRepoId(id)) return null;
  params.delete("repo");
  const query = params.toString();
  return repoPath(id) + (query ? `?${query}` : "");
}

export function navigate(path: string, { replace = false } = {}) {
  const url = new URL(path, window.location.href);
  if (url.href === window.location.href) return;
  const changedPage = url.pathname !== window.location.pathname;
  if (replace) window.history.replaceState(window.history.state, "", url);
  else window.history.pushState(null, "", url);
  if (changedPage) window.scrollTo(0, 0);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

export function useLocation() {
  const href = useSyncExternalStore(subscribe, () => window.location.href);
  return new URL(href);
}
