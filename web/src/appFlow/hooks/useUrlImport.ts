import { useEffect, useRef, useState } from "react";
import { importRepo } from "../../api";
import type { FormError } from "../../pages/LandingImport";
import { validateImport } from "../../pages/importHelpers";
import type { ImportFields } from "../../pages/importHelpers";
import { pollRepoStatus } from "../../pollRepoStatus";
import { navigate, repoPath } from "../../router";
import { trackSignin } from "../../signinEvents";
import type { ImportRequest, ImportResponse, ImportStatus } from "../../types";
import { announceReposChanged } from "./useLandingRepos";

export type UrlImportJob = ImportResponse & { body: ImportRequest };

// The landing's "Analyze a GitHub repo" form: its fields, validation, and the import it started.
export function useUrlImport() {
  const [fields, setFields] = useState<ImportFields>({ url: "", subdir: "", maxCommits: "30" });
  const [formError, setFormError] = useState<FormError | null>(null);
  const [job, setJob] = useState<UrlImportJob | null>(null);
  const [update, setUpdate] = useState<ImportStatus>();
  const [pollError, setPollError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef<AbortController | null>(null);
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
        announceReposChanged();
        if (status.status === "ready") {
          trackSignin("import_completed");
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
      announceReposChanged();
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
    if ("body" in result) {
      trackSignin("import_started");
      void startImport(result.body);
    } else {
      setFormError(result);
      document.getElementById(`import-${result.field}`)?.focus();
    }
  }

  // Try again: poll the same import after a failed check, or start the import again.
  function retry() {
    if (!job) return;
    if (pollError) {
      setPollError(null);
      setJob({ ...job });
    } else void startImport(job.body);
  }

  return { fields, edit, formError, submit, busy, submitting, job, update, pollError, retry };
}
