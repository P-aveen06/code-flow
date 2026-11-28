// Flow C sign-in (C2, C2b, C2c): a modal sheet over the landing page. The landing's "Sign in with
// GitHub" opens it through useSignIn().start(), and "paste a public URL" opens it on the URL form.
// SignInProvider renders the sheet once at the app root, so the sheet runs its hooks only while open.
import { useEffect, useState } from "react";
import { signInUrl } from "../../../api";
import { importProgress, importSteps } from "../../../pages/importHelpers";
import { startSignIn } from "../../../pages/SignInImport";
import { githubReposPath, repoPath, useLocation } from "../../../router";
import type { Me } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { Button } from "../../ui/Button";
import { Avatar, Icon, ModalSheet } from "./kit";
import "./entry.css";

export type UrlImport = ReturnType<typeof useUrlImport>;

type SheetView = "signin" | "url";

// Set by openPublicUrlSheet just before the sheet opens. The sheet reads it when it mounts and
// clears it when it unmounts.
let openOnUrlForm = false;

/** Opens the sign-in sheet on its URL form. `openSheet` is the sign-in piece's openModal. */
export function openPublicUrlSheet(openSheet: () => void) {
  openOnUrlForm = true;
  openSheet();
}

export function SignInModalC({ open, error, onClose }: {
  open: boolean;
  error: string | null;
  onClose: () => void;
}) {
  if (!open) return null;
  return <SignInSheet error={error} onClose={onClose} />;
}

function SignInSheet({ error, onClose }: { error: string | null; onClose: () => void }) {
  const [view, setView] = useState<SheetView>(() => (openOnUrlForm ? "url" : "signin"));
  const { me, signOut } = useMe();
  const importer = useUrlImport();
  const { pathname } = useLocation();

  useEffect(() => () => {
    openOnUrlForm = false;
  }, []);

  // The sheet belongs to the landing page. A link to another page, or an import that opens its
  // repo after two seconds, closes it.
  useEffect(() => {
    if (pathname !== "/") onClose();
  }, [pathname, onClose]);

  // useMe reads the session again after a sign-out, even when the request fails, so the sheet
  // shows the real state without a message of its own.
  async function leave() {
    try {
      await signOut();
    } catch {
      // Nothing to add: the sheet re-renders from the session that useMe reads back.
    }
  }

  return (
    <ModalSheet
      open
      title={view === "url" ? "Analyze a public repository" : "Analyze a repo from your GitHub"}
      onClose={onClose}
    >
      {view === "url" ? (
        <UrlFormC importer={importer} onBack={() => setView("signin")} />
      ) : (
        <SignInView
          me={me}
          error={error}
          onPublicUrl={() => setView("url")}
          onSignOut={() => void leave()}
        />
      )}
    </ModalSheet>
  );
}

function SignInView({ me, error, onPublicUrl, onSignOut }: {
  me: RequestState<Me>;
  error: string | null;
  onPublicUrl: () => void;
  onSignOut: () => void;
}) {
  if (me.status === "loading") {
    return (
      <div className="fc-signin__body">
        <p role="status" className="fc-signin__lead">Checking your GitHub sign-in…</p>
        <div className="fc-signin__bar fc-signin__bar--short" aria-hidden="true"><span /></div>
      </div>
    );
  }
  if (me.status === "error") return <p role="alert" className="fc-signin__error">{me.message}</p>;

  const data = me.data;
  const alert = error && (
    <p role="alert" className="fc-signin__error">
      <Icon name="info" size={17} />
      <span>{error}</span>
    </p>
  );

  if (data.signed_in) {
    return (
      <div className="fc-signin__body">
        {alert}
        <p className="fc-signin__account">
          <Avatar login={data.login} src={data.avatar_url} />
          <span>Signed in as <strong>@{data.login}</strong></span>
        </p>
        <div className="fc-signin__actions">
          <Button variant="primary" className="fc-signin__full" to={githubReposPath}>
            Choose a repository
            <Icon name="arrow-right" size={16} />
          </Button>
          <Button variant="tertiary" className="fc-signin__link" onClick={onSignOut}>Sign out</Button>
          <Button variant="tertiary" className="fc-signin__link" onClick={onPublicUrl}>or paste a public URL</Button>
        </div>
      </div>
    );
  }

  if (!data.configured) {
    return (
      <div className="fc-signin__body">
        {alert}
        <p className="fc-signin__lead">
          GitHub sign-in is not set up on this server yet. You can still analyze a public repo.
        </p>
        <div className="fc-signin__actions">
          <Button variant="primary" className="fc-signin__full" onClick={onPublicUrl}>Paste a public URL</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fc-signin__body">
      {alert}
      <p className="fc-signin__lead">
        Sign in to pick any repo you allow, including private ones. code-flow can only read the code of
        the repos you choose, and only you can see your private imports.
      </p>
      <div className="fc-signin__actions">
        <Button variant="primary" className="fc-signin__full" href={signInUrl()} onClick={startSignIn}>
          <Icon name="github" size={17} />
          Sign in with GitHub
        </Button>
        <Button variant="tertiary" className="fc-signin__link" onClick={onPublicUrl}>or paste a public URL</Button>
      </div>
    </div>
  );
}

/**
 * The public URL form and its import progress. The caller owns the import (useUrlImport), so the
 * sheet and the landing can each show their own. `onBack` adds a link back to the sign-in view.
 */
export function UrlFormC({ importer, onBack }: { importer: UrlImport; onBack?: () => void }) {
  const { fields, edit, formError, submit, busy, submitting } = importer;
  const hosted = import.meta.env.VITE_HOSTED_DEMO === "1";
  const describedBy = (name: string) => (formError?.field === name ? "import-error" : undefined);

  return (
    <div className="fc-signin__body">
      <form
        className="fc-signin__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) submit();
        }}
      >
        <fieldset className="fc-signin__fields" disabled={busy}>
          <div className="fc-signin__field">
            <label className="fc-signin__label" htmlFor="import-url">Repository URL</label>
            <input
              id="import-url" className="fc-signin__input" type="url" required
              placeholder="https://github.com/Flagsmith/flagsmith" value={fields.url}
              aria-invalid={formError?.field === "url"} aria-describedby={describedBy("url")}
              onChange={(event) => edit("url", event.target.value)}
            />
          </div>
          <div className="fc-signin__row">
            <div className="fc-signin__field">
              <label className="fc-signin__label" htmlFor="import-subdir">Subfolder (optional)</label>
              <input
                id="import-subdir" className="fc-signin__input" type="text" placeholder="api/"
                value={fields.subdir} aria-invalid={formError?.field === "subdir"}
                aria-describedby={describedBy("subdir")}
                onChange={(event) => edit("subdir", event.target.value)}
              />
            </div>
            <div className="fc-signin__field">
              <label className="fc-signin__label" htmlFor="import-maxCommits">Max commits</label>
              <input
                id="import-maxCommits" className="fc-signin__input" type="number" min="1" max="200" step="1"
                required value={fields.maxCommits} aria-invalid={formError?.field === "maxCommits"}
                aria-describedby={describedBy("maxCommits")}
                onChange={(event) => edit("maxCommits", event.target.value)}
              />
            </div>
          </div>
          {formError && <p id="import-error" role="alert" className="fc-signin__error">{formError.message}</p>}
          <Button type="submit" variant="primary" className="fc-signin__full">
            {submitting ? "Starting analysis…" : "Analyze"}
          </Button>
        </fieldset>
      </form>
      {hosted && (
        <p className="fc-signin__muted">
          Imports and new commits on this demo are temporary and reset when the server restarts.
          The Flagsmith/flagsmith example is always available.
        </p>
      )}
      <ImportProgressC importer={importer} />
      {onBack && (
        <Button variant="tertiary" className="fc-signin__link" onClick={onBack}>Sign in with GitHub</Button>
      )}
    </div>
  );
}

// The import's steps, its status line, a progress bar and the way on, from the hook's values.
function ImportProgressC({ importer }: { importer: UrlImport }) {
  const { job, update, pollError, retry } = importer;
  if (!job) return null;
  const { step, text, progress, warning } = importProgress(job.status, update);
  const failed = Boolean(pollError) || update?.status === "error";
  const percent = progress ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <section className="fc-signin__progress" aria-label="Import progress">
      <ol className="fc-signin__steps" aria-label="Import steps">
        {importSteps.map(({ status, label }, index) => (
          <li key={status} aria-current={index === step ? "step" : undefined} data-complete={index < step}>
            {label}
          </li>
        ))}
      </ol>
      {failed ? <p role="alert">{pollError || text}</p> : <p role="status">{text}</p>}
      {progress && (
        <div
          className="fc-signin__bar" role="progressbar" aria-label="Commits analyzed"
          aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.current}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      {update && <p className="fc-signin__muted">Elapsed time {update.seconds.toFixed(1)} seconds</p>}
      {warning && <p role="status" className="fc-signin__muted">{warning}</p>}
      {failed && <Button variant="secondary" onClick={retry}>Try again</Button>}
      {update?.status === "ready" && <Button variant="primary" to={repoPath(job.id)}>Open</Button>}
    </section>
  );
}
