export function LandingFlags() {
  return (
    <section className="landing__flags" aria-labelledby="flags-use-title">
      <h2 id="flags-use-title">How Flagsmith is used</h2>
      <div className="landing__flags-grid">
        <article className="card">
          <h3><code>flow_view</code> experiment</h3>
          <p>Overlay + summary won with a <strong>30.6% relative lift in understanding</strong> in a run with 1,300 simulated reviewers. It rolled out in Production.</p>
        </article>
        <article className="card">
          <h3>Flag checks in the diagram</h3>
          <p>Finds Flagsmith and OpenFeature flag checks in the code and shows which calls they guard.</p>
        </article>
        <article className="card">
          <h3><code>variant_preview</code></h3>
          <p>Previews flow view and layout experiment variants in Development only.</p>
        </article>
      </div>
    </section>
  );
}
