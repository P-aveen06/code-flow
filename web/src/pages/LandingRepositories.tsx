import { AppLink } from "../AppLink";
import { repoPath } from "../router";
import type { Repo, RepoStatus } from "../types";
import type { RequestState } from "../useRequest";
import { displaySubdir } from "./importHelpers";

const repoStatusLabels: Record<RepoStatus, string> = {
  queued: "Queued", cloning: "Cloning…", analyzing: "Analyzing…", ready: "Ready", error: "Error",
};

function RepositoryLoading({ waking }: { waking: boolean }) {
  return (
    <>
      <div className="repositories__loading">
        <p role="status">{waking ? "Waking up the demo server (about 30 s)…" : "Loading repositories…"}</p>
        {waking && <progress aria-label="Demo server startup" />}
      </div>
      <ul className="repo-list" aria-hidden="true">
        <li className="repo-list__skeleton">
          <div className="repo-list__details"><span /><span /></div>
          <span />
          <span />
        </li>
      </ul>
    </>
  );
}

export function LandingRepositories({ repos, waking }: {
  repos: RequestState<Repo[]>;
  waking: boolean;
}) {
  return (
    <section className="card repositories" aria-labelledby="repositories-title">
      <h2 id="repositories-title">Analyzed repositories</h2>
      {repos.status === "loading" && <RepositoryLoading waking={waking} />}
      {repos.status === "error" && <p role="alert">{repos.message}</p>}
      {repos.status === "ready" && (repos.data.length ? (
        <ul className="repo-list">
          {repos.data.map((repo) => (
            <li key={repo.id}>
              <div className="repo-list__details">
                <strong>{repo.name}</strong>
                {repo.visibility === "private" && (
                  <span className="status-chip repo-private" title="Only you can see this import">Private</span>
                )}
                <span className="muted">
                  {repo.subdir ? `${displaySubdir(repo.subdir)} · ` : ""}
                  {repo.commit_count} {repo.commit_count === 1 ? "commit" : "commits"}
                </span>
                {repo.status === "error" && <p className="muted">{repo.message}</p>}
                {repo.warning && <p className="state-warning">{repo.warning}</p>}
              </div>
              <span className="status-chip repo-status" data-status={repo.status}>{repoStatusLabels[repo.status]}</span>
              {(repo.status === "ready" || repo.commit_count > 0) && (
                <AppLink href={repoPath(repo.id)} className="btn btn--sm" label={`Open ${repo.name}`}>Open</AppLink>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="empty-state">No repositories analyzed yet. Add a GitHub repo to get started.</p>)}
    </section>
  );
}
