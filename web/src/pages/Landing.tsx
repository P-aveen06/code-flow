import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHostedRepos, fetchRepos, importRepo } from "../api";
import { pollRepoStatus } from "../pollRepoStatus";
import { navigate, repoPath } from "../router";
import type { ImportRequest, ImportResponse, ImportStatus } from "../types";
import { useRequest } from "../useRequest";
import { validateImport } from "./importHelpers";
import type { ImportFields } from "./importHelpers";
import { ImportProgress } from "./ImportProgress";
import { LandingFlags } from "./LandingFlags";
import { LandingHero } from "./LandingHero";
import { LandingImport, type FormError } from "./LandingImport";
import { LandingRepositories } from "./LandingRepositories";

type Job = ImportResponse & { body: ImportRequest };

export function Landing() {
  const hosted = import.meta.env.VITE_HOSTED_DEMO === "1";
  const [fields, setFields] = useState<ImportFields>({ url: "", subdir: "", maxCommits: "30" });
  const [formError, setFormError] = useState<FormError | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [update, setUpdate] = useState<ImportStatus>();
  const [pollError, setPollError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [repoRevision, setRepoRevision] = useState(0);
  const [waking, setWaking] = useState(false);
  const submission = useRef<AbortController | null>(null);
  const loadRepos = useCallback((signal: AbortSignal) => (
    hosted ? fetchHostedRepos(signal) : fetchRepos(signal)
  ), [hosted, repoRevision]);
  const repos = useRequest(loadRepos);
  const busy = submitting || Boolean(job && !pollError && update?.status !== "error");

  useEffect(() => () => submission.current?.abort(), []);

  useEffect(() => {
    setWaking(false);
    if (!hosted || repos.status !== "loading") return;
    const timer = window.setTimeout(() => setWaking(true), 3000);
    return () => window.clearTimeout(timer);
  }, [hosted, loadRepos, repos.status]);

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
          navigationTimer = window.setTimeout(() => navigate(repoPath(id)), 2000);
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

  function submit() {
    const result = validateImport(fields);
    if ("body" in result) void startImport(result.body);
    else {
      setFormError(result);
      document.getElementById(`import-${result.field}`)?.focus();
    }
  }

  return (
    <main className="landing">
      <LandingHero />
      <LandingFlags />
      <LandingRepositories repos={repos} waking={waking} />
      <div className="landing__import" id="import" tabIndex={-1}>
        <LandingImport
          hosted={hosted} fields={fields} formError={formError} busy={busy} submitting={submitting}
          onEdit={edit} onSubmit={submit}
        />
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
    </main>
  );
}
