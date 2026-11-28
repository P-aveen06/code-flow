// Flow B "Workbench" landing: a split hero with the sign-in panel on the right, then the analyzed
// repositories as a table and the Flagsmith notes. The sign-in panel comes from SignInSlot, so the
// landing works with any sign-in piece: flow B's panel for "b", today's card for "today", and its own
// card (sign in or the URL form) for "a" and "c".
import { useState } from "react";
import { usePiece } from "../../AppFlowProvider";
import { SignInSlot } from "../../SignInSlot";
import { useLandingJourney } from "../../hooks/useLandingJourney";
import { useLandingRepos } from "../../hooks/useLandingRepos";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { SignInImport } from "../../../pages/SignInImport";
import { displaySubdir } from "../../../pages/importHelpers";
import { repoPath } from "../../../router";
import type { Me, Repo, RepoStatus } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { Button } from "../../ui/Button";
import { Avatar, Header, Icon, Panel, Table, TableRow } from "./kit";
import { GitHubBody, LandingSharedContext, PublicUrlForm } from "./SignIn";
import type { Account, LandingShared, UrlImport } from "./SignIn";
import "./entry.css";

const PRODUCT_SHOT = "/four-sections-overview.webp";
// The Flagsmith demo opens the flow view of this commit, which the product picture shows too.
const DEMO_COMMIT_PREFIX = "47c774b";

const statusLabels: Record<RepoStatus, string> = {
  queued: "Queued", cloning: "Cloning…", analyzing: "Analyzing…", ready: "Ready", error: "Error",
};

export function LandingB() {
  const { signinError } = useLandingJourney();
  const account = useMe();
  const repos = useLandingRepos();
  const url = useUrlImport();
  const signinPiece = usePiece("signin_layout");
  // Only the cards of pieces other than "b" use this: flow B's panel has its own tabs.
  const [urlChosen, setUrlChosen] = useState(false);
  const shared: LandingShared = { account: { me: account.me, signOut: account.signOut }, url };

  async function signOut() {
    try {
      await account.signOut();
    } finally {
      repos.reload();
    }
  }

  return (
    <LandingSharedContext.Provider value={shared}>
      <Header right={<AccountSummary me={account.me} onSignOut={() => void signOut()} />} />
      <main className="fb-landing">
        <section className="fb-landing__hero" aria-labelledby="landing-title">
          <div className="fb-landing__lead">
            <h1 id="landing-title" className="fb-landing__title">
              See how a commit changes
              <br />
              your code’s flow
            </h1>
            <p className="fb-landing__subtitle">Map the calls that changed in a Python commit.</p>
            <div className="fb-landing__actions">
              <Button to={`${repoPath("Flagsmith__flagsmith")}?commit=${DEMO_COMMIT_PREFIX}`}>
                <Icon name="flow" />Open the Flagsmith demo<Icon name="arrow-right" />
              </Button>
            </div>
            <ProductPicture />
          </div>
          <div className="fb-landing__aside">
            {signinError && signinPiece === "today" && <p role="alert" className="fb-signin__alert">{signinError}</p>}
            {urlChosen && signinPiece !== "b" ? (
              <PublicUrlCard url={url} onGitHub={() => setUrlChosen(false)} />
            ) : (
              <SignInSlot
                placement="hero"
                today={(
                  <div id="import" tabIndex={-1}>
                    <SignInImport onSignedOut={repos.reload} onUseUrl={() => setUrlChosen(true)} />
                  </div>
                )}
                elsewhere={<SignInElsewhere account={shared.account} onUseUrl={() => setUrlChosen(true)} />}
              />
            )}
          </div>
        </section>
        <div className="fb-landing__lower">
          <AnalyzedRepos repos={repos.repos} waking={repos.waking} />
          <FlagsNotes />
        </div>
      </main>
    </LandingSharedContext.Provider>
  );
}

// The product picture: the existing flow view screenshot, framed with the repo, the commit and its counts.
function ProductPicture() {
  return (
    <figure className="fb-landing__shot">
      <figcaption className="fb-landing__shot-bar">
        <span className="fb-landing__shot-repo">
          <Icon name="flow" />Flagsmith/flagsmith <span aria-hidden="true">/</span>
          <span className="fb-landing__mono">api/</span>
        </span>
        <span className="fb-landing__mono">{DEMO_COMMIT_PREFIX}</span>
      </figcaption>
      <img
        className="fb-landing__shot-image"
        src={PRODUCT_SHOT}
        width={1600}
        height={1000}
        alt="The Flagsmith API viewer with a commit timeline, a diagram of changed function calls, source diffs, and a Flagsmith settings panel."
      />
      <p className="fb-landing__shot-foot">
        <Icon name="code" />1 function added, 0 removed, 1 changed
      </p>
    </figure>
  );
}

// Signed-in visitors see their account in the top bar; signing out refreshes the repositories too.
function AccountSummary({ me, onSignOut }: { me: RequestState<Me>; onSignOut: () => void }) {
  if (me.status !== "ready" || !me.data.signed_in) return null;
  return (
    <div className="fb-landing__account">
      <Avatar login={me.data.login} src={me.data.avatar_url} />
      <span className="fb-landing__login">@{me.data.login}</span>
      <Button variant="tertiary" size="sm" onClick={onSignOut}>
        <Icon name="logout" />Sign out
      </Button>
    </div>
  );
}

// The sign-in card for flows A and C, whose sign-in lives on their own page or in their own modal.
// Its button calls the sign-in piece's start(), so the landing does not link to GitHub itself.
function SignInElsewhere({ account, onUseUrl }: { account: Account; onUseUrl: () => void }) {
  return (
    <section className="fb-signin__panel fb-signin__panel--hero" aria-label="Sign in with GitHub">
      <div className="fb-signin__body">
        <GitHubBody account={account} signIn="start" onUseUrl={onUseUrl} />
      </div>
    </section>
  );
}

// The paste-a-URL form on its own, for a landing whose sign-in card is not flow B's panel.
function PublicUrlCard({ url, onGitHub }: { url: UrlImport; onGitHub: () => void }) {
  return (
    <section className="fb-signin__panel fb-signin__panel--hero" aria-label="Analyze a public repository">
      <div className="fb-signin__body">
        <h2 className="fb-signin__title">Analyze a public repository</h2>
        <PublicUrlForm url={url} />
        <div className="fb-signin__actions">
          <Button variant="tertiary" onClick={onGitHub}>Sign in with GitHub instead</Button>
        </div>
      </div>
    </section>
  );
}

function AnalyzedRepos({ repos, waking }: { repos: RequestState<Repo[]>; waking: boolean }) {
  return (
    <Panel title={<span className="fb-landing__panel-title"><Icon name="repo" />Analyzed repositories</span>}>
      {repos.status === "loading" && (
        <div className="fb-landing__loading">
          <p role="status">{waking ? "Waking up the demo server (about 30 s)…" : "Loading repositories…"}</p>
          {waking && <progress aria-label="Demo server startup" />}
        </div>
      )}
      {repos.status === "error" && <p role="alert" className="fb-signin__alert">{repos.message}</p>}
      {repos.status === "ready" && (repos.data.length > 0 ? (
        <Table
          label="Analyzed repositories"
          columns="minmax(0, 39fr) minmax(0, 13fr) minmax(0, 10fr) minmax(0, 25fr) minmax(0, 13fr)"
          head={["Repo", "Subfolder", "Commits", "Status", "Open"]}
        >
          {repos.data.map((repo) => <RepoRow key={repo.id} repo={repo} />)}
        </Table>
      ) : (
        <p className="fb-landing__note">No repositories analyzed yet. Add a GitHub repo to get started.</p>
      ))}
    </Panel>
  );
}

function RepoRow({ repo }: { repo: Repo }) {
  // Like today's landing: a repo can be opened once it is ready or has some commits analyzed.
  const openable = repo.status === "ready" || repo.commit_count > 0;
  return (
    <TableRow>
      <span className="fb-landing__repo">
        <span className="fb-landing__repo-name">{repo.name}</span>
        {repo.visibility === "private" && (
          <span className="fb-landing__badge" title="Only you can see this import">
            <Icon name="lock" size={12} />Private
          </span>
        )}
      </span>
      <span className="fb-landing__mono">{repo.subdir ? displaySubdir(repo.subdir) : "—"}</span>
      <span className="fb-landing__mono">{repo.commit_count}</span>
      <span className="fb-landing__status" data-status={repo.status} title={repo.status === "error" ? repo.message : undefined}>
        {repo.status === "ready" && <Icon name="check" size={12} />}
        {statusLabels[repo.status]}
      </span>
      {openable ? (
        <Button size="sm" variant="tertiary" to={repoPath(repo.id)} aria-label={`Open ${repo.name}`}>
          Open<Icon name="arrow-right" />
        </Button>
      ) : (
        <Button size="sm" variant="tertiary" disabled aria-label={`Open ${repo.name}`}>Open</Button>
      )}
    </TableRow>
  );
}

function FlagsNotes() {
  return (
    <Panel title={<span className="fb-landing__panel-title"><Icon name="flag" />How Flagsmith is used</span>}>
      <ul className="fb-landing__flags">
        <li className="fb-landing__flag">
          <Icon name="flow" />
          <div>
            <h3 className="fb-landing__flag-title"><code>flow_view</code> experiment</h3>
            <p>
              Overlay + summary won with a <strong>30.6% relative lift</strong> in understanding among 1,300
              simulated reviewers. Rolled out in Production.
            </p>
          </div>
        </li>
        <li className="fb-landing__flag">
          <Icon name="flag" />
          <div>
            <h3 className="fb-landing__flag-title">Flag checks in the diagram</h3>
            <p>Finds Flagsmith and OpenFeature flag checks and shows which calls they guard.</p>
          </div>
        </li>
        <li className="fb-landing__flag">
          <Icon name="columns" />
          <div>
            <h3 className="fb-landing__flag-title"><code>variant_preview</code></h3>
            <p>Previews flow view and layout variants in Development only.</p>
          </div>
        </li>
      </ul>
    </Panel>
  );
}
