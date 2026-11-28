// Flow A "Guided" sign-in page at /signin (designs A2, A2b and A2c): four steps at the top and one
// card. The GitHub link is the same as in today's sign-in card (signInUrl and startSignIn), and the
// account states come from useMe, so each state matches today's card.
import { useState } from "react";
import type { ReactNode } from "react";
import { signInUrl } from "../../../api";
import { readSigninError } from "../../../pages/Landing";
import { startSignIn } from "../../../pages/SignInImport";
import { githubReposPath, useLocation } from "../../../router";
import { useMe } from "../../hooks/useMe";
import { useUrlImport } from "../../hooks/useUrlImport";
import { Button } from "../../ui/Button";
import { Avatar, Callout, Card, Header, Icon, Stepper } from "./kit";
import { ImportProgressA, PublicUrlForm } from "./Landing";
import "./entry.css";

/** The mark and the title, the same in every state of the card. */
function CardHead() {
  return (
    <div className="fa-signin__head">
      <span className="fa-signin__mark" aria-hidden="true"><Icon name="github" size={28} /></span>
      <h1 className="fa-signin__title">Analyze a repo from your GitHub</h1>
    </div>
  );
}

function CheckMark() {
  return <span className="fa-signin__check" aria-hidden="true"><Icon name="check" size={14} /></span>;
}

export function SignInPageA() {
  // The message of a failed sign-in comes back in the URL (/signin?signin_error=...).
  const { search } = useLocation();
  const failure = readSigninError(search);
  const { me, signOut } = useMe();
  const importer = useUrlImport();
  const [urlOpen, setUrlOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signedIn = me.status === "ready" && me.data.signed_in === true ? me.data : null;

  // Opens the paste-a-URL form and puts the cursor in its first field.
  function showUrlForm() {
    setUrlOpen(true);
    window.setTimeout(() => document.getElementById("import-url")?.focus());
  }

  async function leave() {
    setSignOutError(null);
    try {
      await signOut();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Could not sign out. Try again.");
    }
  }

  const failureCallout = failure && <Callout role="alert">{failure}</Callout>;
  let card: ReactNode;

  if (me.status === "loading") {
    card = (
      <Card padding="roomy" className="fa-signin__card fa-signin__card--status">
        {failureCallout}
        <CardHead />
        <p role="status" className="fa-signin__lead">Checking your GitHub sign-in…</p>
      </Card>
    );
  } else if (me.status === "error") {
    card = (
      <Card padding="roomy" className="fa-signin__card">
        {failureCallout}
        <CardHead />
        <Callout role="alert">{me.message}</Callout>
      </Card>
    );
  } else if (signedIn) {
    card = (
      <Card padding="roomy" className="fa-signin__card">
        {failureCallout}
        <CardHead />
        <div className="fa-signin__body">
          <p className="fa-signin__account">
            <Avatar login={signedIn.login} src={signedIn.avatar_url} />
            <span>Signed in as <strong>@{signedIn.login}</strong></span>
          </p>
          <Button variant="primary" to={githubReposPath} className="fa-signin__primary">
            Choose a repository <Icon name="arrow-right" size={16} />
          </Button>
          <Button variant="tertiary" size="sm" onClick={() => void leave()}>
            Sign out <Icon name="arrow-right" size={13} />
          </Button>
          {signOutError && <Callout role="alert">{signOutError}</Callout>}
        </div>
      </Card>
    );
  } else if (!me.data.configured) {
    card = (
      <Card padding="roomy" className="fa-signin__card">
        {failureCallout}
        <CardHead />
        <div className="fa-signin__body">
          <p className="fa-signin__lead">
            GitHub sign-in is not set up on this server yet. You can still analyze a public repo.
          </p>
          <Button variant="secondary" onClick={showUrlForm} aria-expanded={urlOpen}>
            Paste a public URL
          </Button>
        </div>
        {urlOpen && <div className="fa-signin__url-form"><PublicUrlForm importer={importer} /></div>}
      </Card>
    );
  } else {
    card = (
      <Card padding="roomy" className="fa-signin__card">
        {failureCallout}
        <CardHead />
        <div className="fa-signin__body">
          <ul className="fa-signin__points">
            <li>
              <CheckMark />
              <span>
                Sign in to pick any repo you allow, including private ones. code-flow can only read the
                code of the repos you choose.
              </span>
            </li>
            <li>
              <CheckMark />
              <span>Only you can see your private imports.</span>
            </li>
          </ul>
          <Button variant="primary" href={signInUrl()} onClick={startSignIn} className="fa-signin__primary">
            <Icon name="github" size={19} />
            Sign in with GitHub
          </Button>
          <details
            className="fa-signin__url"
            open={urlOpen}
            onToggle={(event) => setUrlOpen(event.currentTarget.open)}
          >
            <summary className="fa-signin__url-summary">
              or paste a public URL <Icon name="arrow-right" size={14} />
            </summary>
            <div className="fa-signin__url-form"><PublicUrlForm importer={importer} /></div>
          </details>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Header />
      <main className="fa-signin">
        <Stepper step={signedIn ? 2 : 1} />
        {card}
        {importer.job && (
          <ImportProgressA
            job={importer.job}
            update={importer.update}
            pollError={importer.pollError}
            onRetry={importer.retry}
          />
        )}
      </main>
    </>
  );
}
