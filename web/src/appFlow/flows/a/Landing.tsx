// Flow A "Guided" landing (design A1): one centred column with the main action first, then a
// picture of the commit flow, three steps, how Flagsmith is used and the analyzed repositories.
// The main "Sign in with GitHub" button calls useSignIn().start(), so the sign-in piece decides
// what happens. Signed-in visitors go to their repositories instead.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SignInImport } from "../../../pages/SignInImport";
import { displaySubdir, importProgress, importSteps } from "../../../pages/importHelpers";
import { githubReposPath, repoPath } from "../../../router";
import type { ImportStatus, Repo, RepoStatus } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { usePiece } from "../../AppFlowProvider";
import { useSignIn } from "../../SignInContext";
import { SignInSlot } from "../../SignInSlot";
import { useLandingJourney } from "../../hooks/useLandingJourney";
import { useLandingRepos } from "../../hooks/useLandingRepos";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import type { UrlImportJob } from "../../hooks/useUrlImport";
import { Button } from "../../ui/Button";
import { Avatar, Callout, Chip, Header, Icon } from "./kit";
import type { IconName } from "./kit";
import "./entry.css";

const DEMO_COMMIT_PREFIX = "47c774b";
const demoPath = `${repoPath("Flagsmith__flagsmith")}?commit=${DEMO_COMMIT_PREFIX}`;

const repoStatusLabels: Record<RepoStatus, string> = {
  queued: "Queued", cloning: "Cloning…", analyzing: "Analyzing…", ready: "Ready", error: "Error",
};

const steps = ["Sign in", "Pick a repo and branch", "Read each commit as a flow"];

const flagsmithCards: { icon: IconName; title: ReactNode; text: ReactNode }[] = [
  {
    icon: "layers",
    title: <><code>flow_view</code> experiment</>,
    text: <>Overlay + summary won with a <strong>30.6% relative lift in understanding</strong> in a run with 1,300 simulated reviewers. It rolled out in Production.</>,
  },
  {
    icon: "flag",
    title: "Flag checks in the diagram",
    text: "Finds Flagsmith and OpenFeature flag checks in the code and shows which calls they guard.",
  },
  {
    icon: "code",
    title: <code>variant_preview</code>,
    text: "Previews flow view and layout variants in Development only.",
  },
];

type UrlImport = ReturnType<typeof useUrlImport>;

/** The paste-a-public-URL form. Its fields, validation and import all come from useUrlImport. */
export function PublicUrlForm({ importer }: { importer: UrlImport }) {
  const { fields, edit, formError, submit, busy, submitting } = importer;
  const hosted = import.meta.env.VITE_HOSTED_DEMO === "1";
  // The import hook focuses #import-<field> when validation fails, so the ids must match.
  const errorField = formError?.field;

  return (
    <form
      className="fa-entry__form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) submit();
      }}
    >
      <fieldset className="fa-entry__fields" disabled={busy}>
        <div className="fa-entry__field">
          <label className="fa-entry__label" htmlFor="import-url">Repository URL</label>
          <input
            id="import-url"
            className="fa-entry__input"
            type="url"
            required
            placeholder="https://github.com/Flagsmith/flagsmith"
            value={fields.url}
            aria-invalid={errorField === "url"}
            aria-describedby={errorField === "url" ? "import-error" : undefined}
            onChange={(event) => edit("url", event.target.value)}
          />
        </div>
        <div className="fa-entry__row">
          <div className="fa-entry__field fa-entry__field--grow">
            <label className="fa-entry__label" htmlFor="import-subdir">Subfolder (optional)</label>
            <input
              id="import-subdir"
              className="fa-entry__input fa-entry__input--mono"
              type="text"
              placeholder="api/"
              value={fields.subdir}
              aria-invalid={errorField === "subdir"}
              aria-describedby={errorField === "subdir" ? "import-error" : undefined}
              onChange={(event) => edit("subdir", event.target.value)}
            />
          </div>
          <div className="fa-entry__field fa-entry__field--limit">
            <label className="fa-entry__label" htmlFor="import-maxCommits">Max commits</label>
            <input
              id="import-maxCommits"
              className="fa-entry__input"
              type="number"
              min="1"
              max="200"
              step="1"
              required
              value={fields.maxCommits}
              aria-invalid={errorField === "maxCommits"}
              aria-describedby={errorField === "maxCommits" ? "import-error" : undefined}
              onChange={(event) => edit("maxCommits", event.target.value)}
            />
          </div>
        </div>
        {formError && (
          <div id="import-error">
            <Callout role="alert">{formError.message}</Callout>
          </div>
        )}
        <Button type="submit" variant="primary" className="fa-entry__submit">
          {submitting ? "Starting analysis…" : "Analyze"} <Icon name="arrow-right" size={16} />
        </Button>
      </fieldset>
      {hosted && (
        <p className="fa-entry__hint">
          Imports and new commits on this demo are temporary and reset when the server restarts.
          The Flagsmith/flagsmith example is always available.
        </p>
      )}
    </form>
  );
}

/** The job of a public-URL import: its four steps, the text, the bar and the actions. */
export function ImportProgressA({ job, update, pollError, onRetry }: {
  job: UrlImportJob;
  update?: ImportStatus;
  pollError: string | null;
  onRetry: () => void;
}) {
  const { step, text, progress, warning } = importProgress(job.status, update);
  const failed = Boolean(pollError) || update?.status === "error";
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    card.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <section ref={card} className="fa-card fa-entry__progress" aria-labelledby="import-progress-title">
      <h2 id="import-progress-title" className="fa-entry__progress-title">Import progress</h2>
      <ol className="fa-entry__steps" aria-label="Import steps">
        {importSteps.map(({ status, label }, index) => {
          const state = index < step ? "done" : index === step ? "current" : "upcoming";
          return (
            <li
              key={status}
              className={`fa-entry__step fa-entry__step--${state}`}
              aria-current={index === step ? "step" : undefined}
            >
              <span className="fa-entry__step-dot" aria-hidden="true" />
              {label}
            </li>
          );
        })}
      </ol>
      {failed ? (
        <Callout role="alert">{pollError || text}</Callout>
      ) : (
        <p role="status" className="fa-entry__progress-text">{text}</p>
      )}
      {progress && <progress aria-label="Commits analyzed" value={progress.current} max={progress.total} />}
      {update && <p className="fa-entry__hint">Elapsed time {update.seconds.toFixed(1)} seconds</p>}
      {warning && <p role="status" className="fa-entry__hint">{warning}</p>}
      {(failed || update?.status === "ready") && (
        <div className="fa-entry__progress-actions">
          {failed && <Button onClick={onRetry}>Try again</Button>}
          {update?.status === "ready" && <Button variant="primary" to={repoPath(job.id)}>Open</Button>}
        </div>
      )}
    </section>
  );
}

function RepoRow({ repo }: { repo: Repo }) {
  // The same rule as today's landing: a repo can be opened once it is ready or has commits.
  const canOpen = repo.status === "ready" || repo.commit_count > 0;
  return (
    <li className="fa-landing__repo">
      <span className="fa-landing__repo-icon" aria-hidden="true"><Icon name="code" size={18} /></span>
      <div className="fa-landing__repo-body">
        <div className="fa-landing__repo-name">
          <strong>{repo.name}</strong>
          {repo.visibility === "private" && (
            <span title="Only you can see this import"><Chip><Icon name="lock" size={11} />Private</Chip></span>
          )}
        </div>
        <p className="fa-landing__repo-meta">
          {repo.subdir && <><code>{displaySubdir(repo.subdir)}</code> · </>}
          {repo.commit_count} {repo.commit_count === 1 ? "commit" : "commits"}
        </p>
        {repo.status === "error" && <p className="fa-landing__repo-note">{repo.message}</p>}
        {repo.warning && <p role="status" className="fa-landing__repo-note">{repo.warning}</p>}
      </div>
      <Chip>{repoStatusLabels[repo.status]}</Chip>
      {canOpen && (
        <Button size="sm" to={repoPath(repo.id)} aria-label={`Open ${repo.name}`}>
          Open <Icon name="arrow-right" size={13} />
        </Button>
      )}
    </li>
  );
}

function AnalyzedRepos({ repos, waking }: { repos: RequestState<Repo[]>; waking: boolean }) {
  return (
    <section className="fa-card fa-landing__repos" aria-labelledby="repositories-title">
      <h2 id="repositories-title" className="fa-landing__repos-title">Analyzed repositories</h2>
      {repos.status === "loading" && (
        <div className="fa-landing__loading">
          <p role="status">{waking ? "Waking up the demo server (about 30 s)…" : "Loading repositories…"}</p>
          {waking && <progress aria-label="Demo server startup" />}
        </div>
      )}
      {repos.status === "error" && <p role="alert" className="fa-landing__empty">{repos.message}</p>}
      {repos.status === "ready" && (repos.data.length ? (
        <ul className="fa-landing__repo-list">
          {repos.data.map((repo) => <RepoRow key={repo.id} repo={repo} />)}
        </ul>
      ) : (
        <p className="fa-landing__empty">No repositories analyzed yet. Add a GitHub repo to get started.</p>
      ))}
    </section>
  );
}

const sparklePath = "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z";

/** A picture of the flow view drawn from the sample commit 10483a0 (sample-content.md). */
function FlowPreview() {
  return (
    <div
      className="fa-landing__preview"
      role="img"
      aria-label="The flow view of commit 10483a0: one function added and one changed in experimentation.services, with unchanged neighbours around them."
    >
      <div className="fa-landing__window">
        <div className="fa-landing__window-bar">
          <span className="fa-landing__window-title"><Icon name="code" size={14} /> Commit flow</span>
          <code className="fa-landing__mono-small">api/ · 0c37fca → 10483a0</code>
        </div>
        <div className="fa-landing__window-body">
          <div className="fa-landing__story">
            <div className="fa-landing__story-repo">
              <code className="fa-landing__mono-small">Flagsmith/flagsmith</code>
              <span className="fa-landing__branch">main</span>
            </div>
            <p className="fa-landing__story-title">Compute final results when an experiment is completed</p>
            <p className="fa-landing__story-meta">Zaimwa9 · 27 Nov 2026 · <code>10483a0</code></p>
            <div className="fa-landing__counts">
              <span className="fa-landing__count fa-landing__count--added"><code>+1</code> Added</span>
              <span className="fa-landing__count fa-landing__count--removed"><code>−0</code> Removed</span>
              <span className="fa-landing__count fa-landing__count--changed"><code>~1</code> Changed</span>
            </div>
            <div className="fa-landing__summary">
              <span className="fa-landing__summary-label">
                <svg className="fa-landing__sparkle" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d={sparklePath} />
                </svg>
                AI summary
              </span>
              <p>
                Adds <code>transition_experiment_status._compute_final_results</code>, with 1 function added and 1 changed.
              </p>
            </div>
          </div>
          <div className="fa-landing__diagram">
            <div className="fa-landing__canvas">
              <div className="fa-landing__group">
                <span className="fa-landing__group-name"><Icon name="layers" size={12} /> experimentation.services</span>
              </div>
              <svg className="fa-landing__edges" viewBox="0 0 1000 500" aria-hidden="true" focusable="false">
                <path className="fa-landing__edge" d="M222 289 H268" />
                <path className="fa-landing__head" d="M274 289 L266 285 V293 Z" />
                <path className="fa-landing__edge" d="M610 290 H721 Q735 290 735 276 V236 Q735 226 745 226 H808" />
                <path className="fa-landing__head" d="M816 226 L808 222 V230 Z" />
                <path className="fa-landing__edge" d="M610 301 H721 Q735 301 735 315 V339 Q735 349 745 349 H808" />
                <path className="fa-landing__head" d="M816 349 L808 345 V353 Z" />
              </svg>
              <div className="fa-landing__node fa-landing__node--neighbour fa-landing__node--views">
                <span className="fa-landing__node-count"><Icon name="layers" size={12} /> +1 unchanged</span>
                <code className="fa-landing__node-path">experimentation.views</code>
              </div>
              <div className="fa-landing__node fa-landing__node--changed">
                <span className="fa-landing__node-head">
                  <code className="fa-landing__node-kind">fn</code>
                  <span className="fa-landing__node-status fa-landing__node-status--changed">Changed</span>
                  <code className="fa-landing__node-delta fa-landing__node-delta--changed">+15</code>
                </span>
                <code className="fa-landing__node-name">transition_experiment_status</code>
                <code className="fa-landing__node-path">…/experimentation/services.py:607</code>
              </div>
              <div className="fa-landing__node fa-landing__node--added">
                <span className="fa-landing__node-head">
                  <code className="fa-landing__node-kind">fn</code>
                  <span className="fa-landing__node-status fa-landing__node-status--added">Added</span>
                  <code className="fa-landing__node-delta fa-landing__node-delta--added">+7</code>
                </span>
                <code className="fa-landing__node-name">transition_experiment_status.<wbr />_compute_final_results</code>
                <code className="fa-landing__node-path">…/experimentation/services.py:655</code>
              </div>
              <div className="fa-landing__node fa-landing__node--neighbour fa-landing__node--three">
                <span className="fa-landing__node-count"><Icon name="layers" size={12} /> +3 unchanged</span>
              </div>
              <div className="fa-landing__node fa-landing__node--neighbour fa-landing__node--core">
                <span className="fa-landing__node-count"><Icon name="layers" size={12} /> +1 unchanged</span>
                <code className="fa-landing__node-path">core.dataclasses</code>
              </div>
            </div>
            <div className="fa-landing__legend">
              <span className="fa-landing__key"><span className="fa-landing__swatch fa-landing__swatch--added" />Added</span>
              <span className="fa-landing__key"><span className="fa-landing__swatch fa-landing__swatch--removed" />Removed</span>
              <span className="fa-landing__key"><span className="fa-landing__swatch fa-landing__swatch--changed" />Changed</span>
              <span className="fa-landing__key"><span className="fa-landing__swatch fa-landing__swatch--neighbour" />Unchanged neighbour</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingA() {
  // Once per landing: starts the journeys, cleans the return params, and gives the error of a failed sign-in.
  const { signinError } = useLandingJourney();
  const signInPiece = usePiece("signin_layout");
  const { start } = useSignIn();
  const { me, signOut } = useMe();
  const { repos, waking, reload } = useLandingRepos();
  const importer = useUrlImport();
  const [urlOpen, setUrlOpen] = useState(false);
  const signedIn = me.status === "ready" && me.data.signed_in === true ? me.data : null;

  // Opens the paste-a-URL form and puts the cursor in its first field.
  function showUrlForm() {
    setUrlOpen(true);
    window.setTimeout(() => document.getElementById("import-url")?.focus());
  }

  const account = signedIn && (
    <span className="fa-landing__account">
      <Avatar login={signedIn.login} src={signedIn.avatar_url} />
      <span className="fa-landing__login">@{signedIn.login}</span>
      <Button variant="tertiary" size="sm" onClick={() => void signOut().catch(() => undefined)}>
        Sign out <Icon name="arrow-right" size={13} />
      </Button>
    </span>
  );

  return (
    <>
      <Header right={account} />
      <main className="fa-landing">
        <section className="fa-landing__hero" aria-labelledby="landing-title">
          <h1 id="landing-title" className="fa-landing__title">
            See how a commit changes<br />your code’s flow
          </h1>
          <p className="fa-landing__lead">Map the calls that changed in a Python commit.</p>
          <div className="fa-landing__actions">
            {signedIn ? (
              <Button variant="primary" to={githubReposPath}>
                Choose a repository <Icon name="arrow-right" size={16} />
              </Button>
            ) : (
              <Button variant="primary" onClick={start}>
                <Icon name="github" size={19} />
                Sign in with GitHub
              </Button>
            )}
            <Button variant="secondary" to={demoPath}>
              Open the Flagsmith demo <Icon name="arrow-right" size={16} />
            </Button>
          </div>
          <details
            id="public-url-form"
            className="fa-landing__url"
            open={urlOpen}
            onToggle={(event) => setUrlOpen(event.currentTarget.open)}
          >
            <summary className="fa-landing__url-summary">
              or paste a public URL <Icon name="arrow-right" size={14} />
            </summary>
            <div className="fa-card fa-landing__url-card">
              <PublicUrlForm importer={importer} />
            </div>
          </details>
        </section>

        {signinError && signInPiece === "today" && <Callout role="alert">{signinError}</Callout>}
        {/* Flow A signs in on its own page, so this slot is empty here. Other sign-in pieces fill it. */}
        <SignInSlot
          placement="section"
          today={(
            <div id="import" tabIndex={-1}>
              <SignInImport onSignedOut={reload} onUseUrl={showUrlForm} />
            </div>
          )}
        />

        {importer.job && (
          <ImportProgressA
            job={importer.job}
            update={importer.update}
            pollError={importer.pollError}
            onRetry={importer.retry}
          />
        )}

        <FlowPreview />

        <ol className="fa-landing__steps">
          {steps.map((label, index) => (
            <li key={label} className="fa-landing__step">
              <span className="fa-landing__step-num">{index + 1}</span>
              <span className="fa-landing__step-label">{label}</span>
            </li>
          ))}
        </ol>

        <section className="fa-landing__flags" aria-labelledby="flags-use-title">
          <h2 id="flags-use-title" className="fa-landing__section-title">How Flagsmith is used</h2>
          <div className="fa-landing__flag-grid">
            {flagsmithCards.map(({ icon, title, text }, index) => (
              <article key={index} className="fa-card fa-landing__flag">
                <div className="fa-landing__flag-head">
                  <span className="fa-landing__flag-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>
                  <h3 className="fa-landing__flag-title">{title}</h3>
                </div>
                <p className="fa-landing__flag-text">{text}</p>
              </article>
            ))}
          </div>
        </section>

        <AnalyzedRepos repos={repos} waking={waking} />
      </main>
    </>
  );
}
