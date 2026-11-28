import { useState } from "react";
import { SignInSlot } from "../appFlow/SignInSlot";
import { useLandingJourney } from "../appFlow/hooks/useLandingJourney";
import { useLandingRepos } from "../appFlow/hooks/useLandingRepos";
import { useUrlImport } from "../appFlow/hooks/useUrlImport";
import { ImportProgress } from "./ImportProgress";
import { LandingFlags } from "./LandingFlags";
import { LandingHero } from "./LandingHero";
import { LandingImport } from "./LandingImport";
import { LandingRepositories } from "./LandingRepositories";
import { SignInImport } from "./SignInImport";

export { readSigninError } from "../appFlow/hooks/useLandingJourney";

export function Landing() {
  const hosted = import.meta.env.VITE_HOSTED_DEMO === "1";
  const { signinError, signin } = useLandingJourney();
  const [urlFormChosen, setUrlFormChosen] = useState(false);
  const showSignin = signin.variant === "github_signin" && !urlFormChosen;
  const { repos, waking, reload } = useLandingRepos();
  const { fields, edit, formError, submit, busy, submitting, job, update, pollError, retry } = useUrlImport();

  return (
    <main className="landing">
      <LandingHero />
      <LandingFlags />
      <LandingRepositories repos={repos} waking={waking} />
      <div className="landing__import" id="import" tabIndex={-1}>
        {signinError && <p className="card signin-error" role="alert">{signinError}</p>}
        {!signin.ready && (
          <section className="card import-card" aria-label="Analyze a GitHub repo">
            <p role="status">Loading…</p>
          </section>
        )}
        {signin.ready && showSignin && (
          <SignInSlot
            placement="section"
            today={<SignInImport onSignedOut={reload} onUseUrl={() => setUrlFormChosen(true)} />}
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
        {job && <ImportProgress job={job} update={update} pollError={pollError} onRetry={retry} />}
      </div>
    </main>
  );
}
