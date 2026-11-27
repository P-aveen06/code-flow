import { AppLink } from "../AppLink";
import { repoPath } from "../router";

export function LandingHero() {
  return (
    <section className="landing__hero" aria-labelledby="product-title">
      <div className="landing__lead">
        <h1 id="product-title">See how a commit changes your code’s flow</h1>
        <p>Map the calls that changed in a Python commit.</p>
        <div className="landing__actions">
          <AppLink href={repoPath("Flagsmith__flagsmith")} className="btn btn--primary">Open the Flagsmith demo</AppLink>
          <a href="#import" className="btn">Analyze your own repo</a>
        </div>
      </div>
      <figure className="landing__shot">
        <figcaption className="landing__shot-caption">
          <span className="landing__shot-dots" aria-hidden="true"><span /><span /><span /></span>
          <span>Flagsmith/flagsmith <span aria-hidden="true">·</span> api/</span>
        </figcaption>
        <img
          src="/four-sections-overview.webp" width="1600" height="1000"
          alt="The Flagsmith API viewer with a commit timeline, a diagram of changed function calls, source diffs, and a Flagsmith settings panel."
        />
      </figure>
    </section>
  );
}
