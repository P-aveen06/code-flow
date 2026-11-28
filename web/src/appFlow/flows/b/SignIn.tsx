// Flow B "Workbench" sign-in panel: the inline card in the landing hero (SignInSlot piece "b"). Two
// tabs: GitHub (sign in, or the account when signed in) and Public URL (the paste-a-URL form). On
// flow B's landing it shares that landing's account and URL import; on any other landing it keeps its
// own, so the card works wherever SignInSlot puts it.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { signInUrl } from "../../../api";
import { importProgress, importSteps } from "../../../pages/importHelpers";
import { startSignIn } from "../../../pages/SignInImport";
import { githubReposPath, repoPath } from "../../../router";
import type { ImportStatus, Me } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { Button } from "../../ui/Button";
import { useSignIn } from "../../SignInContext";
import { announceReposChanged } from "../../hooks/useLandingRepos";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { Avatar, Icon, StatusStrip, Tabs } from "./kit";
import type { Tab } from "./kit";
import "./entry.css";

// The GitHub account and sign-out as the landing reads them, so both show the same state.
export interface Account {
  me: RequestState<Me>;
  signOut(): Promise<void>;
}

export type UrlImport = ReturnType<typeof useUrlImport>;

export interface LandingShared {
  account: Account;
  url: UrlImport;
}

// Set by flow B's landing around its sign-in panel and cards. Null on any other landing.
export const LandingSharedContext = createContext<LandingShared | null>(null);

const SIGN_IN_LEAD = "Sign in to pick any repo you allow, including private ones. code-flow can only read the code of the repos you choose, and only you can see your private imports.";
const NOT_SET_UP = "GitHub sign-in is not set up on this server yet. You can still analyze a public repo.";

type Method = "github" | "url";

/** The sign-in panel. `placement` is "hero" beside the landing's product picture, or "section" as a card. */
export function SignInPanelB({ placement }: { placement: "hero" | "section" }) {
  const shared = useContext(LandingSharedContext);
  return shared
    ? <SignInPanel placement={placement} shared={shared} />
    : <StandaloneSignInPanel placement={placement} />;
}

// On a landing without flow B's state, the panel reads the account and the URL import itself.
function StandaloneSignInPanel({ placement }: { placement: "hero" | "section" }) {
  const { me, signOut } = useMe();
  const url = useUrlImport();
  return <SignInPanel placement={placement} shared={{ account: { me, signOut }, url }} />;
}

function SignInPanel({ placement, shared }: { placement: "hero" | "section"; shared: LandingShared }) {
  const { error } = useSignIn();
  const { me } = shared.account;
  const notConfigured = me.status === "ready" && !me.data.configured;
  // Until the visitor picks a tab, a server without GitHub sign-in opens on the public URL form.
  const [chosen, setChosen] = useState<Method | null>(null);
  const method: Method = chosen ?? (notConfigured ? "url" : "github");
  const tabs: Tab[] = [
    { id: "github", label: "GitHub", icon: <Icon name="github" /> },
    { id: "url", label: "Public URL", icon: <Icon name="link" /> },
  ];

  return (
    <section
      id="signin-panel"
      tabIndex={-1}
      className={`fb-signin__panel fb-signin__panel--${placement}`}
      aria-label="Analyze a repo from your GitHub"
    >
      <Tabs tabs={tabs} active={method} onChange={(id) => setChosen(id === "url" ? "url" : "github")} label="Sign-in method" />
      <div className="fb-signin__body">
        {method === "github" ? (
          <>
            {error && <p role="alert" className="fb-signin__alert"><Icon name="info" />{error}</p>}
            <GitHubBody account={shared.account} signIn="link" onUseUrl={() => setChosen("url")} />
          </>
        ) : (
          <PublicUrlBody notConfigured={notConfigured} url={shared.url} />
        )}
      </div>
    </section>
  );
}

/**
 * The GitHub half of a sign-in card, in each state of GET /api/me as SignInImport shows them.
 * "link" sends the visitor straight to GitHub (the sign-in panel). "start" lets the sign-in piece
 * decide, as the landing's own card for flows A and C does.
 */
export function GitHubBody({ account, signIn, onUseUrl }: {
  account: Account;
  signIn: "link" | "start";
  onUseUrl: () => void;
}) {
  const { start } = useSignIn();
  const { me, signOut } = account;

  async function leave() {
    try {
      await signOut();
    } finally {
      announceReposChanged();
    }
  }

  const title = <h2 className="fb-signin__title">Analyze a repo from your GitHub</h2>;

  if (me.status === "loading") {
    return (
      <>
        {title}
        <p className="fb-signin__lead">{SIGN_IN_LEAD}</p>
        <p role="status" className="fb-signin__status"><Icon name="clock" />Checking your GitHub sign-in…</p>
        <SignInActions signIn={signIn} start={start} label="Continue with GitHub" onUseUrl={onUseUrl} />
      </>
    );
  }

  if (me.status === "error") {
    return (
      <>
        {title}
        <p role="alert" className="fb-signin__alert"><Icon name="info" />{me.message}</p>
        <p className="fb-signin__lead">{SIGN_IN_LEAD}</p>
        <SignInActions signIn={signIn} start={start} label="Sign in with GitHub" onUseUrl={onUseUrl} />
      </>
    );
  }

  if (!me.data.configured) {
    return (
      <>
        {title}
        <p role="status" className="fb-signin__status"><Icon name="info" />{NOT_SET_UP}</p>
        <div className="fb-signin__actions">
          <Button variant="primary" onClick={onUseUrl}>Paste a public URL</Button>
        </div>
      </>
    );
  }

  if (me.data.signed_in) {
    return (
      <>
        {title}
        <div className="fb-signin__account">
          <Avatar login={me.data.login} src={me.data.avatar_url} />
          <span className="fb-signin__account-name">Signed in as <strong>@{me.data.login}</strong></span>
          <Button variant="tertiary" size="sm" onClick={() => void leave()}><Icon name="logout" />Sign out</Button>
        </div>
        <div className="fb-signin__actions">
          <Button variant="primary" to={githubReposPath}>
            <Icon name="repo" />Choose a repository<Icon name="arrow-right" />
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      {title}
      <p className="fb-signin__lead">{SIGN_IN_LEAD}</p>
      <SignInActions signIn={signIn} start={start} label="Sign in with GitHub" onUseUrl={onUseUrl} />
    </>
  );
}

function SignInActions({ signIn, start, label, onUseUrl }: {
  signIn: "link" | "start";
  start: () => void;
  label: string;
  onUseUrl: () => void;
}) {
  return (
    <div className="fb-signin__actions">
      {signIn === "link" ? (
        <Button variant="primary" href={signInUrl()} onClick={startSignIn}>
          <Icon name="github" />{label}<Icon name="arrow-right" />
        </Button>
      ) : (
        <Button variant="primary" onClick={start}>
          <Icon name="github" />{label}<Icon name="arrow-right" />
        </Button>
      )}
      <Button variant="tertiary" onClick={onUseUrl}>or paste a public URL</Button>
    </div>
  );
}

function PublicUrlBody({ notConfigured, url }: { notConfigured: boolean; url: UrlImport }) {
  return (
    <>
      {notConfigured && <p role="status" className="fb-signin__status"><Icon name="info" />{NOT_SET_UP}</p>}
      <h2 className="fb-signin__title">Analyze a public repository</h2>
      <PublicUrlForm url={url} />
    </>
  );
}

/** The paste-a-public-URL form and the progress of the import it started. Used by every flow B sign-in card. */
export function PublicUrlForm({ url }: { url: UrlImport }) {
  const { fields, edit, formError, submit, busy, submitting, job, update, pollError, retry } = url;
  const hostedDemo = import.meta.env.VITE_HOSTED_DEMO === "1";
  const fieldError = (field: string) => (formError?.field === field ? "import-error" : undefined);

  return (
    <div className="fb-signin__url">
      <form noValidate className="fb-signin__form" onSubmit={(event) => { event.preventDefault(); if (!busy) submit(); }}>
        <fieldset className="fb-signin__fields" disabled={busy}>
          <div className="fb-signin__field">
            <label className="fb-signin__label" htmlFor="import-url">Repository URL</label>
            <input
              id="import-url"
              className="fb-signin__input"
              type="url"
              required
              placeholder="https://github.com/Flagsmith/flagsmith"
              value={fields.url}
              aria-invalid={formError?.field === "url"}
              aria-describedby={fieldError("url")}
              onChange={(event) => edit("url", event.target.value)}
            />
          </div>
          <div className="fb-signin__row">
            <div className="fb-signin__field">
              <label className="fb-signin__label" htmlFor="import-subdir">Subfolder (optional)</label>
              <input
                id="import-subdir"
                className="fb-signin__input"
                type="text"
                placeholder="api/"
                value={fields.subdir}
                aria-invalid={formError?.field === "subdir"}
                aria-describedby={fieldError("subdir")}
                onChange={(event) => edit("subdir", event.target.value)}
              />
            </div>
            <div className="fb-signin__field">
              <label className="fb-signin__label" htmlFor="import-maxCommits">Max commits</label>
              <input
                id="import-maxCommits"
                className="fb-signin__input"
                type="number"
                min="1"
                max="200"
                step="1"
                required
                value={fields.maxCommits}
                aria-invalid={formError?.field === "maxCommits"}
                aria-describedby={fieldError("maxCommits")}
                onChange={(event) => edit("maxCommits", event.target.value)}
              />
            </div>
          </div>
          {formError && <p id="import-error" role="alert" className="fb-signin__alert">{formError.message}</p>}
          <div className="fb-signin__actions">
            <Button type="submit" variant="primary">{submitting ? "Starting analysis…" : "Analyze"}</Button>
          </div>
        </fieldset>
      </form>
      {hostedDemo && (
        <p className="fb-signin__note">
          Imports and new commits on this demo are temporary and reset when the server restarts.
          The Flagsmith/flagsmith example is always available.
        </p>
      )}
      {job && <ImportStatusB job={job} update={update} pollError={pollError} onRetry={retry} />}
    </div>
  );
}

// The import's steps and text, as ImportProgress shows them, in the flow B status strip.
function ImportStatusB({ job, update, pollError, onRetry }: {
  job: NonNullable<UrlImport["job"]>;
  update?: ImportStatus;
  pollError: string | null;
  onRetry: () => void;
}) {
  const { step, text, progress, warning } = importProgress(job.status, update);
  const failed = Boolean(pollError) || update?.status === "error";
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    card.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div ref={card}>
      <StatusStrip label="Import progress" steps={importSteps.map(({ label }) => label)} current={step}>
        <div className="fb-signin__progress">
          {failed ? <p role="alert">{pollError || text}</p> : <p>{text}</p>}
          {progress && <progress aria-label="Commits analyzed" value={progress.current} max={progress.total} />}
          {update && <p className="fb-signin__note">Elapsed time {update.seconds.toFixed(1)} seconds</p>}
          {warning && <p role="status">{warning}</p>}
          {failed && <Button onClick={onRetry}>Try again</Button>}
          {update?.status === "ready" && <Button variant="primary" to={repoPath(job.id)}>Open</Button>}
        </div>
      </StatusStrip>
    </div>
  );
}
