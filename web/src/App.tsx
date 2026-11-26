import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { fetchCommits, fetchDiff, fetchRepos } from "./api";
import type { CommitList, OverlayNode } from "./types";
import { useRequest } from "./useRequest";
import { CodePane } from "./views/CodePane";
import { Overlay } from "./views/Overlay";
import type { DiffViewProps } from "./views/Overlay";
import { Timeline } from "./views/Timeline";
import { resolveCommit } from "./views/timelineHelpers";

type Hops = 1 | 2;

interface HeaderProps {
  repo?: string;
  context?: { hops: Hops; onChange: (hops: Hops) => void };
  summary?: string;
}

function Header({ repo, context, summary }: HeaderProps) {
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
      {summary !== undefined && (
        <div className="summary-bar">
          <span className="summary-bar__label">Summary</span>
          <p aria-live="polite" title={summary}>
            {summary.split(/(`[^`]+`)/).map((part, index) => (
              index % 2 === 1 ? <code key={index}>{part.slice(1, -1)}</code> : part
            ))}
          </p>
        </div>
      )}
    </header>
  );
}

interface ReviewProps {
  history: CommitList;
  initialPrefix: string | null;
  View: ComponentType<DiffViewProps>;
}

function RepoReview({ history: { repo, commits }, initialPrefix, View }: ReviewProps) {
  const [head, setHead] = useState(() => resolveCommit(commits, initialPrefix)?.sha);
  const [hops, setHops] = useState<Hops>(1);
  const [selectedNode, setSelectedNode] = useState<OverlayNode | null>(null);
  const loadDiff = useCallback(
    (signal: AbortSignal) => head ? fetchDiff(repo, head, { hops }, signal) : Promise.resolve(null),
    [repo, head, hops],
  );
  const request = useRequest(loadDiff);
  const diff = request.status === "ready" ? request.data : null;

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
        summary={diff?.summary ?? (head && request.status === "loading" ? "Loading comparison…" : undefined)}
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
          {diff && <View diff={diff} selectedNodeId={selectedNode?.id} onNodeClick={setSelectedNode} />}
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

export default function App({ view: View = Overlay }: { view?: ComponentType<DiffViewProps> }) {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const loadHistory = useCallback(async (signal: AbortSignal) => {
    const repos = await fetchRepos(signal);
    const repo = repos.find(({ name }) => name === params.get("repo")) ?? repos[0];
    return repo ? fetchCommits(repo.name, signal) : null;
  }, [params]);
  const history = useRequest(loadHistory);

  if (history.status === "ready" && history.data) {
    return <RepoReview history={history.data} initialPrefix={params.get("commit")} View={View} />;
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
