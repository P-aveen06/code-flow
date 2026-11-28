// Flow C "Canvas" landing: a full-bleed hero with a picture of commit 10483a0, then the commit
// strip, the Flagsmith cards and the analyzed repositories. "Sign in with GitHub" calls
// useSignIn().start(), so the sign-in piece decides what happens. The sign-in sheet is in SignIn.tsx.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { displaySubdir } from "../../../pages/importHelpers";
import { SignInImport } from "../../../pages/SignInImport";
import { githubReposPath, repoPath } from "../../../router";
import type { Repo, RepoStatus } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { useSignIn } from "../../SignInContext";
import { SignInSlot } from "../../SignInSlot";
import { useLandingJourney } from "../../hooks/useLandingJourney";
import { useLandingRepos } from "../../hooks/useLandingRepos";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { Button } from "../../ui/Button";
import { AvatarMenu, CanvasBackground, Header, Icon, Pill } from "./kit";
import { UrlFormC, openPublicUrlSheet } from "./SignIn";
import "./entry.css";

// The flow view of the demo repo, on the commit the hero picture shows.
const demoPath = `${repoPath("Flagsmith__flagsmith")}?commit=10483a0`;

export function LandingC() {
  const { piece, start, openModal } = useSignIn();
  const { signinError } = useLandingJourney();
  const { me, signOut } = useMe();
  const { repos, waking, reload } = useLandingRepos();
  const importer = useUrlImport();
  const [urlChosen, setUrlChosen] = useState(false);
  const urlSection = useRef<HTMLElement>(null);
  const signedIn = me.status === "ready" && me.data.signed_in;

  useEffect(() => {
    if (urlChosen) urlSection.current?.querySelector("input")?.focus();
  }, [urlChosen]);

  // "paste a public URL" opens the sign-in sheet on its URL form. A sign-in piece with no sheet
  // (today's card, B's panel, A's page) gets the URL form on this page instead.
  function pasteUrl() {
    if (piece === "c") openPublicUrlSheet(openModal);
    else setUrlChosen(true);
  }

  return (
    <>
      <Header
        right={me.status === "ready" && (
          // A sign-out that fails still re-reads the session in useMe, so the menu needs no error.
          <AvatarMenu me={me.data} onSignOut={() => void signOut().catch(() => undefined)} />
        )}
      />
      <main className="fc-landing">
        <CanvasBackground className="fc-landing__hero">
          <div className="fc-landing__lead">
            <h1 className="fc-landing__title">
              See how a commit<br />changes your<br />code’s flow
            </h1>
            <p className="fc-landing__sub">Map the calls that changed in a Python commit.</p>
            <div className="fc-landing__actions">
              <div className="fc-landing__buttons">
                {signedIn ? (
                  <Button variant="primary" to={githubReposPath}>
                    Choose a repository
                    <Icon name="arrow-right" size={16} />
                  </Button>
                ) : (
                  <Button variant="primary" onClick={start}>
                    <Icon name="github" size={16} />
                    Sign in with GitHub
                  </Button>
                )}
                <Button variant="secondary" to={demoPath}>Open the Flagsmith demo</Button>
              </div>
              <Button variant="tertiary" className="fc-landing__paste" onClick={pasteUrl}>paste a public URL</Button>
            </div>
          </div>
          <ProductPicture />
          <CommitTimeline />
        </CanvasBackground>

        <div className="fc-landing__body">
          {piece === "today" && signinError && <p role="alert" className="fc-landing__alert">{signinError}</p>}
          <SignInSlot
            placement="section"
            today={(
              <div id="import" tabIndex={-1}>
                <SignInImport onSignedOut={reload} onUseUrl={pasteUrl} />
              </div>
            )}
          />
          {urlChosen && piece !== "c" && (
            <section ref={urlSection} className="fc-landing__url" aria-labelledby="fc-landing-url">
              <h2 id="fc-landing-url" className="fc-landing__heading">Analyze a public repository</h2>
              <UrlFormC importer={importer} />
            </section>
          )}

          <section className="fc-landing__section" aria-labelledby="fc-landing-commits">
            <h2 id="fc-landing-commits" className="fc-landing__heading">Commit by commit</h2>
            <div className="fc-landing__commit-grid">
              <CommitExample sha="add5187" title="feat(experimentation): add a Snowflake statement client (#9008)" counts={[20, 0, 0]}>
                <span className="fc-landing__chip fc-landing__chip--added">20 added</span>
              </CommitExample>
              <CommitExample sha="10483a0" title="fix(experimentation): compute final results when an experiment is completed (#9140)" counts={[1, 0, 1]}>
                <span className="fc-landing__chip fc-landing__chip--changed">transition…</span>
                <Icon name="arrow-right" size={16} />
                <span className="fc-landing__chip fc-landing__chip--added">_compute_final_results</span>
              </CommitExample>
              <CommitExample sha="0c37fca" title="fix(feature-health): accept webhook reasons missing text or url blocks (#9110)" counts={[2, 2, 2]}>
                <span className="fc-landing__chip fc-landing__chip--added">2 added</span>
                <span className="fc-landing__chip fc-landing__chip--removed">2 removed</span>
                <span className="fc-landing__chip fc-landing__chip--changed">2 changed</span>
              </CommitExample>
            </div>
          </section>

          <section className="fc-landing__section" aria-labelledby="fc-landing-flags">
            <h2 id="fc-landing-flags" className="fc-landing__heading">How Flagsmith is used</h2>
            <div className="fc-landing__flag-grid">
              <article className="fc-landing__flag">
                <p className="fc-landing__stat">30.6%</p>
                <h3 className="fc-landing__flag-label"><code className="fc-landing__mono">flow_view</code> experiment</h3>
                <p className="fc-landing__muted">
                  Overlay + summary won with this relative lift in understanding across 1,300 simulated
                  reviewers. Rolled out in Production.
                </p>
              </article>
              <article className="fc-landing__flag">
                <Icon name="branch" size={30} />
                <h3 className="fc-landing__flag-title">Flag checks in the diagram</h3>
                <p className="fc-landing__muted">
                  Finds Flagsmith and OpenFeature flag checks in the code and shows which calls they guard.
                </p>
              </article>
              <article className="fc-landing__flag">
                <Icon name="layers" size={30} />
                <h3 className="fc-landing__flag-title"><code className="fc-landing__mono">variant_preview</code></h3>
                <p className="fc-landing__muted">Previews flow view and layout variants in Development only.</p>
              </article>
            </div>
          </section>

          <section className="fc-landing__section" aria-labelledby="fc-landing-repos">
            <h2 id="fc-landing-repos" className="fc-landing__heading">Analyzed repositories</h2>
            <RepoList repos={repos} waking={waking} />
          </section>
        </div>
      </main>
    </>
  );
}

// The hero's picture of commit 10483a0 (sample content). It is a stand-in drawn in cards and
// connectors, not FlowCanvas: the flow view draws the real diagram.
const wires = [
  { left: 190, top: 128, width: 20 },
  { left: 486, top: 127, width: 32, height: 2, live: true },
  { left: 456, top: 54, height: 26 },
  { left: 456, top: 54, width: 384 },
  { left: 840, top: 54, height: 16 },
  { left: 840, top: 70, width: 12 },
  { left: 414, top: 176, height: 32 },
  { left: 414, top: 208, width: 406 },
  { left: 820, top: 183, height: 25 },
  { left: 820, top: 183, width: 32 },
];

const arrowheads = [
  { left: 204, top: 124 },
  { left: 512, top: 124, live: true },
  { left: 846, top: 66 },
  { left: 846, top: 179 },
];

function ProductPicture() {
  return (
    <>
      <div className="fc-landing__chip-bar">
        <Icon name="repo" size={16} />
        <span className="fc-landing__strong">Flagsmith/flagsmith</span>
        <Pill><span className="fc-landing__mono">api/</span></Pill>
        <Pill><Icon name="branch" size={13} />main</Pill>
        <span className="fc-landing__divider" aria-hidden="true" />
        <span className="fc-landing__mono">10483a0</span>
      </div>
      <div
        className="fc-landing__picture"
        role="img"
        aria-label="Commit 10483a0: a changed function and an added function in experimentation.services, with unchanged neighbours around them."
      >
        <div className="fc-landing__group">
          <span className="fc-landing__mono">experimentation.services</span>
        </div>
        {wires.map(({ left, top, width, height, live }, index) => (
          <span
            key={index}
            className={live ? "fc-landing__wire fc-landing__wire--live" : "fc-landing__wire"}
            style={{ left, top, width: width ?? 1, height: height ?? 1 }}
          />
        ))}
        {arrowheads.map(({ left, top, live }, index) => (
          <span
            key={index}
            className={live ? "fc-landing__arrow fc-landing__arrow--live" : "fc-landing__arrow"}
            style={{ left, top }}
          />
        ))}
        <div className="fc-landing__node fc-landing__node--changed">
          <span className="fc-landing__node-head"><span>fn · Changed</span><span className="fc-landing__strong">+15</span></span>
          <span className="fc-landing__node-name fc-landing__mono">transition_experiment_status</span>
          <span className="fc-landing__node-path fc-landing__mono">…/experimentation/services.py:607</span>
        </div>
        <div className="fc-landing__node fc-landing__node--added">
          <span className="fc-landing__node-head"><span>fn · Added</span><span className="fc-landing__strong">+7</span></span>
          <span className="fc-landing__node-name fc-landing__mono">transition_experiment_status._compute_final_results</span>
          <span className="fc-landing__node-path fc-landing__mono">…/experimentation/services.py:655</span>
        </div>
        <div className="fc-landing__node fc-landing__node--context fc-landing__node--ctx1">
          <span className="fc-landing__strong">+1 unchanged</span>
          <span className="fc-landing__mono fc-landing__small">experimentation.views</span>
        </div>
        <div className="fc-landing__node fc-landing__node--context fc-landing__node--ctx2">
          <span className="fc-landing__strong">+3 unchanged</span>
        </div>
        <div className="fc-landing__node fc-landing__node--context fc-landing__node--ctx3">
          <span className="fc-landing__strong">+1 unchanged</span>
          <span className="fc-landing__mono fc-landing__small">core.dataclasses</span>
        </div>
      </div>
    </>
  );
}

// The commit scrubber under the picture: one dot per commit, the selected one in the selection accent.
const timelineDots = [
  "ink-lg", "quiet", "selected", "ink", "quiet", "quiet-lg",
  "ink", "quiet-lg", "quiet", "ink", "quiet", "quiet",
] as const;

function CommitTimeline() {
  return (
    <div className="fc-landing__timeline">
      <span className="fc-landing__mono fc-landing__muted">0c37fca → 10483a0</span>
      <div className="fc-landing__track">
        {timelineDots.map((kind, index) => (
          <span key={index} className={`fc-landing__dot fc-landing__dot--${kind}`} />
        ))}
      </div>
    </div>
  );
}

function CommitExample({ sha, title, counts, children }: {
  sha: string;
  title: string;
  counts: [number, number, number];
  children: ReactNode;
}) {
  const [added, removed, changed] = counts;
  return (
    <article className="fc-landing__commit">
      <div className="fc-landing__thumb">{children}</div>
      <div className="fc-landing__meta">
        <code className="fc-landing__mono fc-landing__muted">{sha}</code>
        <span className="fc-landing__counts">
          <Pill tone="added">+{added}</Pill>
          <Pill tone="removed">−{removed}</Pill>
          <Pill tone="changed">~{changed}</Pill>
        </span>
      </div>
      <p className="fc-landing__commit-title">{title}</p>
    </article>
  );
}

const repoStatusLabels: Record<RepoStatus, string> = {
  queued: "Queued", cloning: "Cloning…", analyzing: "Analyzing…", ready: "Ready", error: "Error",
};

function RepoList({ repos, waking }: { repos: RequestState<Repo[]>; waking: boolean }) {
  if (repos.status === "loading") {
    return waking ? (
      <div className="fc-landing__waking">
        <p role="status" className="fc-landing__muted">Waking up the demo server (about 30 s)…</p>
        <div className="fc-landing__bar" role="progressbar" aria-label="Demo server startup"><span /></div>
      </div>
    ) : (
      <p role="status" className="fc-landing__muted">Loading repositories…</p>
    );
  }
  if (repos.status === "error") return <p role="alert" className="fc-landing__muted">{repos.message}</p>;
  if (repos.data.length === 0) {
    return <p className="fc-landing__muted">No repositories analyzed yet. Add a GitHub repo to get started.</p>;
  }
  return (
    <div className="fc-landing__repo-grid">
      {repos.data.map((repo) => <RepoCard key={repo.id} repo={repo} />)}
    </div>
  );
}

function RepoCard({ repo }: { repo: Repo }) {
  // Today's rule: a repo opens once it is ready or has commits.
  const openable = repo.status === "ready" || repo.commit_count > 0;
  const openLabel = (
    <>
      Open
      <Icon name="arrow-up-right" size={14} />
    </>
  );
  return (
    <article className="fc-landing__repo">
      <div className="fc-landing__repo-head">
        <Icon name="repo" size={18} />
        <h3 className="fc-landing__repo-name">{repo.name}</h3>
        {repo.visibility === "private" && (
          <Pill><Icon name="lock" size={12} />Private</Pill>
        )}
      </div>
      <div className="fc-landing__repo-foot">
        <span className="fc-landing__muted">
          {repo.subdir && (
            <>
              <span className="fc-landing__mono">{displaySubdir(repo.subdir)}</span>
              {" · "}
            </>
          )}
          {repo.commit_count} {repo.commit_count === 1 ? "commit" : "commits"}
        </span>
        <Pill>
          {repo.status === "ready" && <Icon name="check" size={13} />}
          {repoStatusLabels[repo.status]}
        </Pill>
        {openable ? (
          <Button variant="secondary" size="sm" className="fc-landing__open" to={repoPath(repo.id)} aria-label={`Open ${repo.name}`}>
            {openLabel}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" className="fc-landing__open" disabled>
            {openLabel}
          </Button>
        )}
      </div>
      {repo.status === "error" && <p className="fc-landing__muted">{repo.message}</p>}
      {repo.warning && <p role="status" className="fc-landing__muted">{repo.warning}</p>}
    </article>
  );
}
