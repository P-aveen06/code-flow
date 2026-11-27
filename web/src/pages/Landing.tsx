import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHostedRepos, fetchRepos, importPickedRepo, importRepo } from "../api";
import { useSigninVariant } from "../flags";
import { pollRepoStatus } from "../pollRepoStatus";
import { navigate, repoPath, useLocation } from "../router";
import { beginJourney, trackSignin, watchForAbandon } from "../signinEvents";
import type { ImportRequest, ImportResponse, ImportStatus, PickedImportRequest } from "../types";
import { useRequest } from "../useRequest";
import { validateImport } from "./importHelpers";
import type { ImportFields } from "./importHelpers";
import { ImportProgress } from "./ImportProgress";
import { LandingFlags } from "./LandingFlags";
import { LandingHero } from "./LandingHero";
import { LandingImport, type FormError } from "./LandingImport";
import { LandingRepositories } from "./LandingRepositories";
import { SignInImport } from "./SignInImport";

type ImportBody = ImportRequest | PickedImportRequest;
type Job = ImportResponse & { body: ImportBody };

// GitHub sends the visitor back with one of these; the page reads them once, then drops them.
const returnParams = ["signed_in", "signin_error", "github"];
const signinErrors: Record<string, string> = {
  denied: "GitHub sign-in was cancelled.",
  expired: "The sign-in took too long or started in another tab. Try again.",
  github: "GitHub did not accept the sign-in. Try again.",
};

export function readSigninReturn(search: string) {
  const params = new URLSearchParams(search);
  return {
    signedIn: params.get("signed_in") === "1",
    installed: params.get("github") === "installed",
    error: signinErrors[params.get("signin_error") ?? ""] ?? null,
  };
}

export function Landing() {
  const hosted = import.meta.env.VITE_HOSTED_DEMO === "1";
  const { search } = useLocation();
  const signin = useSigninVariant(search);
  const [returned] = useState(() => readSigninReturn(search));
  const [urlFormChosen, setUrlFormChosen] = useState(false);
  const showSignin = signin.variant === "github_signin" && !urlFormChosen;
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
    const params = new URLSearchParams(window.location.search);
    if (!returnParams.some((name) => params.has(name))) return;
    returnParams.forEach((name) => params.delete(name));
    const query = params.toString();
    navigate(`${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`, { replace: true });
  }, []);

  useEffect(() => {
    if (!signin.ready) return;
    beginJourney(signin.reviewerId, signin.variant, signin.exposed);
    if (returned.signedIn) trackSignin("signin_completed");
  }, [signin.ready, signin.reviewerId, signin.variant, signin.exposed, returned.signedIn]);

  useEffect(() => watchForAbandon(), []);

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

  useEffect(() => {
    if (repos.status !== "ready" || repos.data.every(({ status }) => status === "ready" || status === "error")) return;
    const timer = window.setTimeout(() => setRepoRevision((revision) => revision + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [repos]);

  function edit(field: keyof ImportFields, value: string) {
    setFields((previous) => ({ ...previous, [field]: value }));
    if (formError) setFormError(null);
  }

  async function startImport(body: ImportBody) {
    if (submission.current) return;
    const controller = new AbortController();
    submission.current = controller;
    setSubmitting(true);
    setFormError(null);
    setJob(null);
    setUpdate(undefined);
    setPollError(null);
    try {
      const response = "url" in body
        ? await importRepo(body, controller.signal)
        : await importPickedRepo(body, controller.signal);
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
    if ("body" in result) {
      trackSignin("import_started");
      void startImport(result.body);
    }
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
        {returned.error && <p className="card signin-error" role="alert">{returned.error}</p>}
        {!signin.ready && (
          <section className="card import-card" aria-label="Analyze a GitHub repo">
            <p role="status">Loading…</p>
          </section>
        )}
        {signin.ready && showSignin && (
          <SignInImport
            busy={busy} submitting={submitting} error={formError?.message ?? null} installed={returned.installed}
            onImport={(body) => void startImport(body)}
            onSignedOut={() => setRepoRevision((revision) => revision + 1)}
            onUseUrl={() => setUrlFormChosen(true)}
          />
        )}
        {signin.ready && !showSignin && (
          <LandingImport
            hosted={hosted} fields={fields} formError={formError} busy={busy} submitting={submitting}
            onEdit={edit} onSubmit={submit}
          />
        )}
        {signin.ready && signin.variant === "github_signin" && urlFormChosen && (
          <button type="button" className="link-button" onClick={() => setUrlFormChosen(false)}>
            Sign in with GitHub instead
          </button>
        )}
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
