import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRepos, importRepo } from "../api";
import { AppLink } from "../AppLink";
import { useCodeFlowFlags } from "../flags";
import { pollRepoStatus } from "../pollRepoStatus";
import { navigate, repoPath } from "../router";
import type { ImportRequest, ImportResponse, ImportStatus, RepoStatus } from "../types";
import { useRequest } from "../useRequest";
import { replaceSyncOverride, syncPreviewPath } from "../view";
import { SyncPreview } from "../views/VariantPreview";
import { AutoSyncSwitch, autoSyncStatusText } from "./AutoSyncControls";
import { displaySubdir, validateImport } from "./importHelpers";
import type { ImportFields } from "./importHelpers";
import { ImportProgress } from "./ImportProgress";
import { useAutoSync } from "./useAutoSync";

const example: ImportFields = { url: "https://github.com/Flagsmith/flagsmith", subdir: "api", maxCommits: "50" };
const repoStatusLabels: Record<RepoStatus, string> = {
  queued: "Queued", cloning: "Cloning…", analyzing: "Analyzing…", ready: "Ready", error: "Error",
};

type Job = ImportResponse & { body: ImportRequest };
type FormError = { field?: keyof ImportFields; message: string };

export function Landing({ search }: { search: string }) {
  const { syncMode, syncOverride, assignedSyncMode, variantPreview } = useCodeFlowFlags(search, "landing");
  const autoSyncEnabled = syncMode !== "manual_button";
  const autoSync = useAutoSync(autoSyncEnabled);
  const [fields, setFields] = useState<ImportFields>({ url: "", subdir: "", maxCommits: "30" });
  const [formError, setFormError] = useState<FormError | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [update, setUpdate] = useState<ImportStatus>();
  const [pollError, setPollError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [repoRevision, setRepoRevision] = useState(0);
  const submission = useRef<AbortController | null>(null);
  const loadRepos = useCallback((signal: AbortSignal) => fetchRepos(signal), [repoRevision]);
  const repos = useRequest(loadRepos);
  const busy = submitting || Boolean(job && !pollError && update?.status !== "error");

  useEffect(() => () => submission.current?.abort(), []);

  useEffect(() => {
    if (!job) return;
    const { id } = job;
    const controller = new AbortController();
    let navigationTimer: number | undefined;

    void pollRepoStatus(id, controller.signal, setUpdate).then(
      (status) => {
        if (controller.signal.aborted) return;
        setRepoRevision((revision) => revision + 1);
        if (status.status === "ready") {
          navigationTimer = window.setTimeout(() => {
            const override = new URLSearchParams(window.location.search).get("sync");
            navigate(syncPreviewPath(repoPath(id), override));
          }, 2000);
        }
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

  useEffect(() => {
    if (repos.status !== "ready" || repos.data.every(({ status }) => status === "ready" || status === "error")) return;
    const timer = window.setTimeout(() => setRepoRevision((revision) => revision + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [repos]);

  function edit(field: keyof ImportFields, value: string) {
    setFields((previous) => ({ ...previous, [field]: value }));
    if (formError) setFormError(null);
  }

  async function startImport(body: ImportRequest) {
    if (submission.current) return;
    const controller = new AbortController();
    submission.current = controller;
    setSubmitting(true);
    setFormError(null);
    setJob(null);
    setUpdate(undefined);
    setPollError(null);
    try {
      const response = await importRepo(body, controller.signal);
      if (controller.signal.aborted) return;
      setJob({ ...response, body });
      setRepoRevision((revision) => revision + 1);
    } catch (error) {
      if (!controller.signal.aborted) {
        setFormError({ message: error instanceof Error ? error.message : "Could not start the import." });
      }
    } finally {
      if (!controller.signal.aborted) {
        submission.current = null;
        setSubmitting(false);
      }
    }
  }

  function submit(values: ImportFields) {
    const result = validateImport(values);
    if ("body" in result) void startImport(result.body);
    else {
      setFormError(result);
      document.getElementById(`import-${result.field}`)?.focus();
    }
  }

  return (
    <main className="landing">
      <div className="landing__intro">
        <section aria-labelledby="product-title">
          <h1 id="product-title">code-flow</h1>
          <p className="landing__pitch">See how your code's flow changes, commit by commit, as a diagram instead of a 1,000-line diff.</p>
          <p className="landing__support">For Python repositories. Built for the Flagsmith Toggle Wars hackathon.</p>
        </section>
        <section className="landing__how" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol>
            <li>Paste a GitHub repo.</li>
            <li>code-flow maps the functions and the calls between them for each commit.</li>
            <li>Click a commit to see what it changed. Green means added, red means removed, and amber means changed.</li>
          </ol>
        </section>
      </div>

      <div className="landing__import">
        <section className="card import-card" aria-labelledby="import-title">
          <h2 id="import-title">Analyze a GitHub repo</h2>
          <form noValidate onSubmit={(event) => { event.preventDefault(); if (!busy) submit(fields); }}>
            <fieldset disabled={busy}>
              <div className="field">
                <label className="field__label" htmlFor="import-url">GitHub repository URL</label>
                <input
                  id="import-url" className="input" type="url" required
                  placeholder="https://github.com/owner/repo" value={fields.url}
                  aria-invalid={formError?.field === "url"}
                  aria-describedby={formError?.field === "url" ? "import-error" : undefined}
                  onChange={(event) => edit("url", event.target.value)}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="import-subdir">Subfolder (optional)</label>
                <input
                  id="import-subdir" className="input" type="text" value={fields.subdir}
                  aria-invalid={formError?.field === "subdir"}
                  aria-describedby={formError?.field === "subdir" ? "subdir-hint import-error" : "subdir-hint"}
                  onChange={(event) => edit("subdir", event.target.value)}
                />
                <p className="muted field__hint" id="subdir-hint">e.g. api/ — only Python under this folder is analyzed</p>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="import-maxCommits">Number of recent commits</label>
                <input
                  id="import-maxCommits" className="input" type="number" min="1" max="200" step="1" required
                  value={fields.maxCommits}
                  aria-invalid={formError?.field === "maxCommits"}
                  aria-describedby={formError?.field === "maxCommits" ? "import-error" : undefined}
                  onChange={(event) => edit("maxCommits", event.target.value)}
                />
              </div>
              {formError && <p className="field" id="import-error" role="alert">{formError.message}</p>}
              <button type="submit" className="btn btn--primary">{submitting ? "Starting analysis…" : "Analyze repository"}</button>
            </fieldset>
          </form>
          <div className="import-examples">
            <h3>Try an example</h3>
            <div className="import-examples__actions">
              <button
                type="button" className="btn btn--sm" disabled={busy}
                onClick={() => { setFields(example); submit(example); }}
              >
                Flagsmith/flagsmith (api/)
              </button>
              <AppLink href={syncPreviewPath(repoPath("shop-demo"), syncOverride)} className="btn btn--sm">shop-demo (tutorial)</AppLink>
            </div>
          </div>
        </section>

        {job && (
          <ImportProgress
            job={job} update={update} pollError={pollError}
            onRetry={() => {
              if (pollError) {
                setPollError(null);
                setJob({ ...job });
              } else void startImport(job.body);
            }}
          />
        )}
      </div>

      <section className="card repositories" aria-labelledby="repositories-title">
        <h2 id="repositories-title">Analyzed repositories</h2>
        {variantPreview && (
          <SyncPreview mode={syncMode} override={syncOverride} assignedMode={assignedSyncMode}
            onChange={replaceSyncOverride} />
        )}
        {syncMode === "global_toggle" && (
          <AutoSyncSwitch checked={autoSync.checked(null)} disabled={autoSync.disabled}
            error={autoSync.saveError?.repoId === null ? autoSync.saveError.message : undefined}
            onChange={(checked) => void autoSync.change(null, checked)} />
        )}
        {autoSyncEnabled && autoSync.loadError && (
          <p className="muted" role="alert">Could not load auto-sync settings. {autoSync.loadError}</p>
        )}
        {repos.status === "loading" && <p role="status">Loading repositories…</p>}
        {repos.status === "error" && <p role="alert">{repos.message}</p>}
        {repos.status === "ready" && (repos.data.length ? (
          <ul className="repo-list">
            {repos.data.map((repo) => {
              const status = autoSync.saved?.status[repo.id];
              const showSync = autoSyncEnabled && repo.url?.startsWith("https://github.com/")
                && (repo.status === "ready" || repo.commit_count > 0 || status);
              const synced = autoSync.checked(null) || autoSync.checked(repo.id);
              return (
                <li key={repo.id}>
                  <div className="repo-list__details">
                    <strong>{repo.name}</strong>
                    <span className="muted">
                      {repo.subdir ? `${displaySubdir(repo.subdir)} · ` : ""}
                      {repo.commit_count} {repo.commit_count === 1 ? "commit" : "commits"}
                    </span>
                    {repo.status === "error" && <p className="muted">{repo.message}</p>}
                    {repo.warning && <p className="state-warning">{repo.warning}</p>}
                    {showSync && autoSync.saved && (
                      <p className="muted">{autoSyncStatusText(status, synced)}</p>
                    )}
                  </div>
                  {showSync && syncMode === "per_repo_toggle" && (
                    <AutoSyncSwitch repoName={repo.name} checked={autoSync.checked(repo.id)} disabled={autoSync.disabled}
                      error={autoSync.saveError?.repoId === repo.id ? autoSync.saveError.message : undefined}
                      onChange={(checked) => void autoSync.change(repo.id, checked)} />
                  )}
                  <span className="status-chip repo-status" data-status={repo.status}>{repoStatusLabels[repo.status]}</span>
                  {(repo.status === "ready" || repo.commit_count > 0) && (
                    <AppLink href={syncPreviewPath(repoPath(repo.id), syncOverride)} className="btn btn--sm" label={`Open ${repo.name}`}>Open</AppLink>
                  )}
                </li>
              );
            })}
          </ul>
        ) : <p className="empty-state">No repositories analyzed yet. Add a GitHub repo above to get started.</p>)}
      </section>
    </main>
  );
}
