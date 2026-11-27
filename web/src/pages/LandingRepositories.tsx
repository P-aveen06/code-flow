import { AppLink } from "../AppLink";
import { repoPath } from "../router";
import type { Repo, RepoStatus } from "../types";
import type { RequestState } from "../useRequest";
import type { LandingVariant } from "../view";
import { displaySubdir } from "./importHelpers";

const repoStatusLabels: Record<RepoStatus, string> = {
  queued: "Queued", cloning: "Cloning…", analyzing: "Analyzing…", ready: "Ready", error: "Error",
};

function RepositoryLoading({ preview, waking }: { preview: boolean; waking: boolean }) {
  if (!preview) return <p role="status">{waking ? "Waking up the demo server…" : "Loading repositories…"}</p>;

  return (
    <>
      <div className="landing-preview__loading">
        <p role="status">{waking ? "Waking up the demo server (about 30 s)…" : "Loading repositories…"}</p>
        {waking && <progress aria-label="Demo server startup" />}
      </div>
      <ul className="repo-list" aria-hidden="true">
        <li className="landing-preview__skeleton">
          <div className="repo-list__details"><span /><span /></div>
          <span />
          <span />
        </li>
      </ul>
    </>
  );
}

export function LandingRepositories({ variant, repos, waking }: {
  variant: LandingVariant | null;
  repos: RequestState<Repo[]>;
  waking: boolean;
}) {
  const sectionClass = variant === "b" || variant === "c" ? "repositories" : "card repositories";

  return (
    <section className={sectionClass} aria-labelledby="repositories-title">
      <h2 id="repositories-title">Analyzed repositories</h2>
      {repos.status === "loading" && <RepositoryLoading preview={variant !== null} waking={waking} />}
      {repos.status === "error" && <p role="alert">{repos.message}</p>}
      {repos.status === "ready" && (repos.data.length ? (
        <ul className="repo-list">
          {repos.data.map((repo) => (
            <li key={repo.id}>
              <div className="repo-list__details">
                <strong>{repo.name}</strong>
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
      ) : <p className="empty-state">No repositories analyzed yet. Add a GitHub repo{variant === "a" ? "" : " above"} to get started.</p>)}
    </section>
  );
}
