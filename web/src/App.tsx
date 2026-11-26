import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { fetchCommits, fetchRepos } from "./api";
import { recordReviewEvent } from "./events";
import type { CommitList, DiffViewModel, OverlayNode } from "./types";
import { useDiff } from "./useDiff";
import type { Hops } from "./useDiff";
import { useRequest } from "./useRequest";
import { readFlowView } from "./view";
import type { FlowView } from "./view";
import { CodePane } from "./views/CodePane";
import { FlowLegend } from "./views/FlowCanvas";
import { Overlay } from "./views/Overlay";
import type { DiffViewProps } from "./views/Overlay";
import { OverlaySummary } from "./views/OverlaySummary";
import { ReviewBar } from "./views/ReviewBar";
import { SideBySide } from "./views/SideBySide";
import { Timeline } from "./views/Timeline";
import { resolveCommit } from "./views/timelineHelpers";

const diffViews: Record<FlowView, ComponentType<DiffViewProps>> = {
  side_by_side: SideBySide,
  overlay: Overlay,
  overlay_summary: OverlaySummary,
};

interface HeaderProps {
  repo?: string;
  context?: { hops: Hops; onChange: (hops: Hops) => void };
}

function Header({ repo, context }: HeaderProps) {
  return (
    <header>
      <div className="topbar">
        <div className="topbar__brand">
          <span className="topbar__brand-mark" aria-hidden="true">↳</span>
          <h1>code-flow</h1>
        </div>
        {repo && <span className="topbar__repo" title={repo}>{repo}</span>}
        {context && (
          <div className="topbar__context">
            <span id="context-label" className="muted">Context</span>
            <div className="segmented" role="group" aria-labelledby="context-label">
              {([1, 2] as const).map((hops) => (
                <button
                  key={hops}
                  type="button"
                  className={`segmented__btn${context.hops === hops ? " is-active" : ""}`}
                  aria-pressed={context.hops === hops}
                  onClick={() => context.onChange(hops)}
                >
                  {hops} {hops === 1 ? "hop" : "hops"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

interface ReviewProps {
  history: CommitList;
  initialPrefix: string | null;
  view: FlowView;
}

function RepoReview({ history: { repo, commits }, initialPrefix, view }: ReviewProps) {
  const [head, setHead] = useState(() => resolveCommit(commits, initialPrefix)?.sha);
  const [hops, setHops] = useState<Hops>(1);
  const [selectedNode, setSelectedNode] = useState<OverlayNode | null>(null);
  const [rendered, setRendered] = useState<{ diff: DiffViewModel; view: FlowView } | null>(null);
  const { request, diff, layout } = useDiff(repo, head, hops);
  const markRendered = useCallback(() => {
    if (diff) setRendered({ diff, view });
  }, [diff, view]);
  const reviewContext = diff && rendered?.diff === diff && rendered.view === view
    ? { repo, view, head: diff.head, base: diff.base }
    : null;
  const View = diffViews[view];

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("repo", repo);
    if (head) url.searchParams.set("commit", head);
    else url.searchParams.delete("commit");
    window.history.replaceState(window.history.state, "", url);
  }, [repo, head]);

  function selectCommit(sha: string) {
    if (sha === head) return;
    setSelectedNode(null);
    setHead(sha);
  }

  function changeHops(next: Hops) {
    if (next === hops) return;
    setSelectedNode(null);
    setHops(next);
  }

  return (
    <div className="app">
      <Header
        repo={repo}
        context={head ? { hops, onChange: changeHops } : undefined}
      />
      <main className={`workspace${selectedNode && diff ? " workspace--with-code" : ""}`}>
        <Timeline commits={commits} selectedSha={head} onSelect={selectCommit} />
        <section className="graph-panel" aria-labelledby="flow-title">
          <div className="panel-heading">
            <h2 id="flow-title">Flow diff</h2>
            {diff && (
              <code className="graph-panel__range muted" title={`${diff.base || "Empty graph"} → ${diff.head}`}>
                {diff.base ? diff.base.slice(0, 7) : "Empty graph"} → {diff.head.slice(0, 7)}
              </code>
            )}
          </div>
          {!head && <p className="panel-message">There are no commits to compare.</p>}
          {head && request.status === "loading" && (
            <p className="panel-message" role="status">Loading flow diff…</p>
          )}
          {request.status === "error" && <p className="panel-message" role="alert">{request.message}</p>}
          {diff && layout.status === "loading" && (
            <p className="panel-message" role="status">Laying out the flow…</p>
          )}
          {diff && layout.status === "error" && (
            <p className="panel-message" role="alert">Could not lay out the flow. {layout.message}</p>
          )}
          {diff && layout.status === "ready" && layout.data && (
            <div className="flow-comparison">
              <View
                diff={diff}
                layout={layout.data}
                selectedNodeId={selectedNode?.id}
                onNodeClick={setSelectedNode}
                onReady={markRendered}
              />
              {layout.data.nodes.length > 0 && <FlowLegend />}
            </div>
          )}
          {head && (
            <ReviewBar
              key={JSON.stringify([repo, head, view])}
              context={reviewContext}
              onReview={recordReviewEvent}
            />
          )}
        </section>
        {selectedNode && diff && (
          <CodePane
            repo={repo}
            head={diff.head}
            base={diff.base}
            node={selectedNode}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </main>
    </div>
  );
}

export default function App() {
  const [search] = useState(() => window.location.search);
  const [params] = useState(() => new URLSearchParams(search));
  const view = readFlowView(search);
  const loadHistory = useCallback(async (signal: AbortSignal) => {
    const repos = await fetchRepos(signal);
    const repo = repos.find(({ name }) => name === params.get("repo")) ?? repos[0];
    return repo ? fetchCommits(repo.name, signal) : null;
  }, [params]);
  const history = useRequest(loadHistory);

  if (history.status === "ready" && history.data) {
    return <RepoReview history={history.data} initialPrefix={params.get("commit")} view={view} />;
  }

  return (
    <div className="app">
      <Header />
      <main className="app-message">
        {history.status === "loading" && <p role="status">Loading repositories…</p>}
        {history.status === "error" && <p role="alert">{history.message}</p>}
        {history.status === "ready" && <p>No analyzed repositories are available.</p>}
      </main>
    </div>
  );
}
