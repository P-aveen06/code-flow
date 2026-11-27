import type { ReactNode } from "react";
import { AppLink } from "../AppLink";
import type { LandingVariant } from "../view";
import { demoRepoPath } from "./LandingImport";
import "./landing-preview.css";

type LandingSections = { importForm: ReactNode; repositories: ReactNode };

function DemoFirst({ importForm, repositories }: LandingSections) {
  return (
    <main className="landing-preview landing-preview--a">
      <section className="landing-preview__demo" aria-labelledby="product-title">
        <div className="landing-preview__lead">
          <h1 id="product-title">See how a commit changes your code’s flow</h1>
          <p>Map the calls that changed in a Python commit.</p>
          <div className="landing-preview__actions">
            <AppLink href={demoRepoPath} className="btn btn--primary">Open the Flagsmith demo</AppLink>
            <a href="#import" className="btn">Analyze your own repo</a>
          </div>
        </div>
        <figure className="landing-preview__browser">
          <figcaption className="landing-preview__browser-bar">
            <span className="landing-preview__browser-dots" aria-hidden="true"><span /><span /><span /></span>
            <span>Flagsmith/flagsmith <span aria-hidden="true">·</span> api/</span>
          </figcaption>
          <img
            src="/four-sections-overview.webp" width="1600" height="1000"
            alt="The Flagsmith API viewer with a commit timeline, a diagram of changed function calls, source diffs, and a flag checks panel."
          />
        </figure>
      </section>
      <section className="landing-preview__flags" aria-labelledby="flags-use-title">
        <h2 id="flags-use-title">How Flagsmith is used</h2>
        <div className="landing-preview__flags-grid">
          <article className="card">
            <h3><code>flow_view</code> experiment</h3>
            <p>Overlay + summary won with <strong>30.6% higher understanding</strong> among simulated reviewers.</p>
          </article>
          <article className="card">
            <h3>Flag checks in the diagram</h3>
            <p>Flagsmith mode shows which calls are guarded and which paths are live.</p>
          </article>
          <article className="card">
            <h3>Preview flags</h3>
            <p>Try viewer layouts and landing pages with <code>variant_preview</code>.</p>
          </article>
        </div>
      </section>
      {repositories}
      <div className="landing-preview__import" id="import" tabIndex={-1}>{importForm}</div>
    </main>
  );
}

const steps = [
  { title: "Paste a GitHub repo", icon: <path d="m10 13 4-4m-6 6-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m2 3a3 3 0 0 0 4 0l4-4a3 3 0 0 0-4-4l-1 1" /> },
  { title: "Map functions and calls", icon: <path d="M6 8v8m0-4h9m0-6h4v4h-4zm0 8h4v4h-4zM4 4h4v4H4zm0 12h4v4H4zm13-6v4" /> },
  { title: "Click a commit to see what changed", icon: <path d="M4 12h4m8 0h4m-4 0a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" /> },
];

function SplitHero({ importForm, repositories }: LandingSections) {
  return (
    <main className="landing-preview landing-preview--b">
      <div className="landing-preview__split">
        <section className="landing-preview__lead" aria-labelledby="product-title">
          <h1 id="product-title">See what changed in every commit</h1>
          <p>Turn a Python repo’s history into diagrams you can explore.</p>
          <section className="landing-preview__how" aria-labelledby="how-title">
            <h2 id="how-title">How it works</h2>
            <ol>
              {steps.map(({ title, icon }) => (
                <li key={title}>
                  <span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {icon}
                    </svg>
                  </span>
                  {title}
                </li>
              ))}
            </ol>
          </section>
          <p className="landing-preview__badge">Built with Flagsmith</p>
        </section>
        <div className="landing-preview__import">{importForm}</div>
      </div>
      {repositories}
      <footer className="landing-preview__footer">
        <a href="https://github.com/P-aveen06/code-flow">GitHub repo</a>
        <a href="https://www.flagsmith.com/">Flagsmith</a>
      </footer>
    </main>
  );
}

function SearchHero({ importForm, repositories }: LandingSections) {
  return (
    <main className="landing-preview landing-preview--c">
      <section className="landing-preview__search" aria-labelledby="product-title">
        <div className="landing-preview__lead">
          <h1 id="product-title">code-flow</h1>
          <p>See how a Python repo changes, one commit at a time.</p>
        </div>
        <div className="landing-preview__import">{importForm}</div>
      </section>
      {repositories}
    </main>
  );
}

export function LandingPreview({ variant, ...sections }: LandingSections & { variant: LandingVariant }) {
  if (variant === "a") return <DemoFirst {...sections} />;
  if (variant === "b") return <SplitHero {...sections} />;
  return <SearchHero {...sections} />;
}
