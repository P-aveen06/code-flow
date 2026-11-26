import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCommits, fetchRepos, fetchSnapshot } from "../api";
import { AppLink } from "../AppLink";
import { recordReviewEvent } from "../events";
import { directionExposureKey, readFlowDirection, useCodeFlowFlags, useDirectionExposure } from "../flags";
import type { FlowLayout } from "../layout/elk";
import { navigate, repoPath } from "../router";
import type { DiffViewModel, FlagCheck, FlagFinding, OverlayNode, TimelineCommit } from "../types";
import { useDiff, useDiffLayout } from "../useDiff";
import type { Hops } from "../useDiff";
import { useRepoFlags } from "../useRepoFlags";
import { useRequest } from "../useRequest";
import { replaceDirectionOverride, replaceViewOverride } from "../view";
import type { FlowDirection, FlowView } from "../view";
import { CodePane } from "../views/CodePane";
import type { CodeSource } from "../views/CodePane";
import { FlagsmithPanel } from "../views/FlagsmithPanel";
import { FlowLegend } from "../views/FlowCanvas";
import { Overlay } from "../views/Overlay";
import { OverlaySummary } from "../views/OverlaySummary";
import { ReviewBar } from "../views/ReviewBar";
import { SideBySide } from "../views/SideBySide";
import { Timeline } from "../views/Timeline";
import { DirectionPreview, VariantPreview } from "../views/VariantPreview";
import type { ExpandedContext } from "../views/collapse";
import { liveFlagStates, toggleFlagSelection } from "../views/flagFindings";
import { useDiagramFullscreen } from "../views/fullscreen";
import { layoutPositionKey, useLayoutPositions } from "../views/layoutPositions";
import {
  formatCommitDate, formatFunctionCounts, hasFlowChange, nearestFlowChange, resolveCommit,
} from "../views/timelineHelpers";
import { displaySubdir } from "./importHelpers";

const guidePreference = "code-flow:diagram-guide";
const neighboursHint = "How many callers/callees around the changed functions to show";

function readGuidePreference() {
  try {
    return window.localStorage.getItem(guidePreference) !== "closed";
  } catch {
    return true;
  }
}

async function hasNonemptySnapshot(id: string, commits: TimelineCommit[], signal: AbortSignal) {
  // An addition or change proves that the commit's own snapshot contains nodes.
  if (commits.some(({ stats }) => stats.nodes_added > 0 || stats.nodes_changed > 0)) return true;
  // With no additions, later first-parent snapshots can only keep or remove the oldest snapshot's nodes.
  const first = commits[0];
  if (!first) return false;
  const snapshot = await fetchSnapshot(id, first.sha, signal);
  return snapshot.nodes.length > 0;
}

function DiagramGuide({ onClose }: { onClose: () => void }) {
  const [more, setMore] = useState(false);

  return (
    <aside className={more ? "diagram-guide diagram-guide--expanded" : "diagram-guide"}
      id="diagram-guide" aria-labelledby="diagram-guide-title">
      <div className="diagram-guide__heading">
        <h3 id="diagram-guide-title">What am I looking at?</h3>
        <p>Boxes show Python symbols and arrows show calls. Click a symbol to read its code.</p>
        <div className="diagram-guide__actions">
          <button
            type="button" className="btn btn--sm" aria-expanded={more}
            aria-controls="diagram-guide-details" onClick={() => setMore(!more)}
          >{more ? "Less" : "More"}</button>
          <button type="button" className="btn btn--sm" onClick={onClose}>Dismiss</button>
        </div>
      </div>
      <ul id="diagram-guide-details" hidden={!more}>
        <li>Symbols are grouped by module. Click a context chip to expand its module.</li>
        <li>A → B means A calls B. A label like <code>new_checkout: on</code> shows when that call runs.</li>
        <li>Use <kbd>↑</kbd> and <kbd>↓</kbd> to step through commits.</li>
      </ul>
    </aside>
  );
}

function NoFlowChange({ next, onReady }: {
  next: { href: string; direction: string } | null;
  onReady: () => void;
}) {
  useEffect(onReady, [onReady]);

  return (
    <div className="canvas-empty">
      <p>This commit didn't change any Python functions or calls (it may touch tests, docs, migrations or other languages).</p>
      {next && <AppLink href={next.href}>Go to the {next.direction} commit with flow changes</AppLink>}
    </div>
  );
}

interface RepoReviewProps {
  id: string;
  name: string;
  subdir: string | null;
  hasNodes: boolean;
  commits: TimelineCommit[];
  search: string;
}

function RepoReview({ id, name, subdir, hasNodes, commits, search }: RepoReviewProps) {
  const {
    flowView: view, reviewerId, viewOverride, flagsmithMode, ready: flagsReady, assignedView, reviewEventClient,
    directionFlag,
  } = useCodeFlowFlags(search);
  const selected = resolveCommit(commits, new URLSearchParams(search).get("commit"));
  const head = selected?.sha;
  const findings = useRepoFlags(id, flagsmithMode ? head : undefined);
  const flags = findings.status === "ready" ? findings.data : undefined;
  const liveStates = useMemo(() => liveFlagStates(flags), [flags]);
  const [flagSelection, setFlagSelection] = useState<{
    head: string | undefined; finding: FlagFinding;
  }>();
  const selectedFlag = flags?.flags.some((flag) => flag.name === flagSelection?.finding.name)
    && flagSelection?.head === head ? flagSelection?.finding : undefined;
  const checkIds = useMemo(() => selectedFlag?.checks.map((check) => check.function), [selectedFlag]);
  const [hops, setHops] = useState<Hops>(1);
  const [guideOpen, setGuideOpen] = useState(readGuidePreference);
  const guideButton = useRef<HTMLButtonElement>(null);
  const [context, setContext] = useState<{ head: string | undefined; expanded: ExpandedContext }>(
    () => ({ head, expanded: new Set() }),
  );
  if (context.head !== head) setContext({ head, expanded: new Set() });
  const [selection, setSelection] = useState<
    { diff: DiffViewModel; node: OverlayNode } | { head: string; check: FlagCheck } | null
  >(null);
  const [rendered, setRendered] = useState<{
    layout: FlowLayout; view: FlowView; direction: FlowDirection;
  } | null>(null);
  const request = useDiff(id, hasNodes ? head : undefined, hops);
  const diff = request.status === "ready" ? request.data : null;
  const longFlow = diff ? diff.long_flow === true : undefined;
  const { direction, directionOverride, assignedDirection, ready: directionReady } = readFlowDirection(
    search, longFlow, directionFlag,
  );
  const { layout, hasCollapsedContext } = useDiffLayout(
    diff, context.expanded, view === "side_by_side", flagsReady && directionReady ? direction : null, checkIds,
  );
  const currentLayout = layout.status === "ready" ? layout.data : null;
  const layoutPositions = useLayoutPositions(layoutPositionKey(id, head ?? "", view, direction));
  const contextExpanded = context.expanded === "all" || context.expanded.size > 0;
  const selectedNode = selection && "node" in selection && selection.diff === diff ? selection.node : null;
  let source: CodeSource | undefined;
  if (selectedNode && diff) {
    const { in_head, file, line, end_line, qualname, status } = selectedNode;
    source = {
      sha: in_head ? diff.head : diff.base, revision: in_head ? "Head" : "Base",
      file, line, endLine: end_line, name: qualname, status,
    };
  } else if (selection && "check" in selection && selection.head === head) {
    const { file, line } = selection.check;
    source = { sha: head, revision: "Head", file, line, endLine: line, name: `${file}:${line}` };
  }
  const markRendered = useCallback(() => {
    if (currentLayout) setRendered({ layout: currentLayout, view, direction });
  }, [currentLayout, view, direction]);
  const diagramRendered = Boolean(currentLayout && rendered?.layout === currentLayout
    && rendered.view === view && rendered.direction === direction);
  const exposureKey = directionExposureKey(reviewerId, longFlow, directionOverride, directionFlag);
  const layoutReview = useDirectionExposure(reviewerId, exposureKey, diagramRendered);
  const reviewContext = diff && diagramRendered && layoutReview.ready
    ? { repo: id, view, reviewerId, head: diff.head, base: diff.base, devOverride: viewOverride !== null }
    : null;
  const View = view === "side_by_side" ? SideBySide : Overlay;
  const flowChanged = selected && hasFlowChange(selected.stats);
  const fullscreen = useDiagramFullscreen(Boolean(flowChanged && layout.status === "ready" && layout.data?.nodes.length));
  const nextChange = selected && !flowChanged ? nearestFlowChange(commits, selected.sha) : null;

  useEffect(() => {
    if (!selectedFlag) return;
    function clearHighlight(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) setFlagSelection(undefined);
    }
    window.addEventListener("keydown", clearHighlight);
    return () => window.removeEventListener("keydown", clearHighlight);
  }, [selectedFlag]);

  const commitHref = useCallback((sha: string) => {
    const params = new URLSearchParams(search);
    params.set("commit", sha);
    return `${repoPath(id)}?${params}`;
  }, [id, search]);

  const selectCommit = useCallback((sha: string) => {
    if (sha !== head) {
      setFlagSelection(undefined);
      navigate(commitHref(sha));
    }
  }, [commitHref, head]);

  function setGuide(open: boolean) {
    setGuideOpen(open);
    try {
      window.localStorage.setItem(guidePreference, open ? "open" : "closed");
    } catch {
      // The guide still works when storage is blocked.
    }
  }

  function expandModule(module: string) {
    setContext(({ expanded }) => ({
      head, expanded: expanded === "all" ? expanded : new Set([...expanded, module]),
    }));
  }

  return (
    <main className="viewer">
      <header className="viewer-header">
        <div className="viewer-header__details">
          <h1>{name}</h1>
          {subdir && <p className="viewer-header__subdir">Subfolder <code>{displaySubdir(subdir)}</code></p>}
          {selected && (
            <div className="viewer-header__commit">
              <h2>{selected.message || "Untitled commit"}</h2>
              <div className="commit-meta">
                <span>{selected.author}</span>
                <time dateTime={selected.date}>{formatCommitDate(selected.date)}</time>
                <code title={selected.sha}>{selected.sha.slice(0, 7)}</code>
                <span className="commit-meta__counts">{formatFunctionCounts(selected.stats)}</span>
              </div>
            </div>
          )}
        </div>
        <div className="viewer-header__controls">
          <VariantPreview view={view} viewOverride={viewOverride} assignedView={assignedView}
            ready={flagsReady} onChange={replaceViewOverride} />
          {hasNodes && head && (
            <DirectionPreview direction={direction} directionOverride={directionOverride}
              assignedDirection={assignedDirection} longFlow={longFlow}
              ready={directionReady} onChange={replaceDirectionOverride} />
          )}
          {hasNodes && (
            <div className="neighbours" title={neighboursHint}>
              <span id="neighbours-label">Show neighbours:</span>
              <div className="segmented" role="group" aria-labelledby="neighbours-label" aria-description={neighboursHint}>
                {([1, 2] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={hops === option ? "segmented__btn is-active" : "segmented__btn"}
                    aria-pressed={hops === option}
                    onClick={() => setHops(option)}
                  >
                    {option} {option === 1 ? "step" : "steps"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </header>
      <div className={source || flagsmithMode ? "workspace workspace--with-drawer" : "workspace"}>
        <Timeline commits={commits} selectedSha={head} onSelect={selectCommit} />
        <section className={fullscreen.maximized ? "graph-panel graph-panel--maximized" : "graph-panel"}
          aria-labelledby="flow-title" ref={fullscreen.panel}>
          <div className="panel-heading">
            <h2 id="flow-title">Flow diff</h2>
            {diff && (
              <code className="graph-panel__range muted" title={`${diff.base || "Empty graph"} → ${diff.head}`}>
                {diff.base ? diff.base.slice(0, 7) : "Empty graph"} → {diff.head.slice(0, 7)}
              </code>
            )}
            {diff && flowChanged && (hasCollapsedContext || contextExpanded) && (
              <button
                type="button" className="btn btn--sm"
                onClick={() => setContext({ head, expanded: hasCollapsedContext ? "all" : new Set() })}
              >{hasCollapsedContext ? "Expand all context" : "Collapse context"}</button>
            )}
            {hasNodes && (
              <button
                ref={guideButton} type="button" className="btn btn--sm"
                aria-label="What am I looking at?" aria-expanded={guideOpen}
                aria-controls={guideOpen ? "diagram-guide" : undefined}
                title="What am I looking at?" onClick={() => setGuide(!guideOpen)}
              >?</button>
            )}
          </div>
          {hasNodes && guideOpen && (
            <DiagramGuide onClose={() => { setGuide(false); guideButton.current?.focus(); }} />
          )}
          {!hasNodes && (
            <div className="canvas-empty">
              <p>No Python code found in {subdir ? displaySubdir(subdir) : "this repository"}. code-flow analyzes Python only for now.</p>
            </div>
          )}
          {hasNodes && (!flagsReady || request.status === "loading") && (
            <p className="panel-message" role="status">Loading flow diff…</p>
          )}
          {request.status === "error" && <p className="panel-message" role="alert">{request.message}</p>}
          {diff && flagsReady && !directionReady && <p className="panel-message" role="status">Loading flow direction…</p>}
          {diff && flagsReady && directionReady && layout.status === "loading" && (
            <p className="panel-message" role="status">Laying out the flow…</p>
          )}
          {diff && layout.status === "error" && (
            <p className="panel-message" role="alert">Could not lay out the flow. {layout.message}</p>
          )}
          {diff && currentLayout && (
            <div className="flow-comparison">
              {view === "overlay_summary" && <OverlaySummary summary={diff.summary} />}
              {flowChanged ? (
                <>
                  <View
                    key={`${view}:${direction}`}
                    diff={diff}
                    layout={currentLayout}
                    direction={direction}
                    layoutPositions={layoutPositions}
                    fullscreen={fullscreen}
                    selectedNodeId={selectedNode?.id}
                    selectedFlag={selectedFlag}
                    liveStates={liveStates}
                    onNodeClick={(node) => setSelection({ diff, node })}
                    onExpandModule={expandModule}
                    onReady={markRendered}
                  />
                  <FlowLegend flagsmithMode={flagsmithMode} />
                </>
              ) : (
                <NoFlowChange
                  next={nextChange && { href: commitHref(nextChange.sha), direction: nextChange.direction }}
                  onReady={markRendered}
                />
              )}
            </div>
          )}
          {hasNodes && head && (
            <ReviewBar
              key={JSON.stringify([id, head, view, reviewerId, viewOverride, direction, directionOverride])}
              context={reviewContext}
              sendsReviewEvents={reviewEventClient !== null || layoutReview.exposed}
              onReview={(payload) => recordReviewEvent(payload, reviewEventClient, {
                ...layoutReview, override: directionOverride,
              })}
            />
          )}
        </section>
        {(source || flagsmithMode) && (
          <div className="drawer workspace__drawer">
            {flagsmithMode && (
              <FlagsmithPanel
                data={flags}
                error={findings.status === "error" ? findings.message : undefined}
                loading={Boolean(head) && findings.status === "loading"}
                selected={selectedFlag?.name}
                onSelect={(finding) => {
                  const name = toggleFlagSelection(selectedFlag?.name, finding.name);
                  setFlagSelection(name ? { head, finding } : undefined);
                }}
                onOpenCheck={(check) => { if (head) setSelection({ head, check }); }}
              />
            )}
            {source && <CodePane repo={id} source={source} onClose={() => setSelection(null)} />}
          </div>
        )}
      </div>
    </main>
  );
}

export function Viewer({ id, search }: { id: string; search: string }) {
  const loadReview = useCallback(async (signal: AbortSignal) => {
    const [history, repos] = await Promise.all([fetchCommits(id, signal), fetchRepos(signal)]);
    const repo = repos.find((entry) => entry.id === id);
    const hasNodes = repo?.warning ? false : await hasNonemptySnapshot(id, history.commits, signal);
    return { commits: history.commits, name: repo?.name ?? history.repo, subdir: repo?.subdir ?? null, hasNodes };
  }, [id]);
  const review = useRequest(loadReview);

  if (review.status === "ready") return <RepoReview id={id} search={search} {...review.data} />;
  return (
    <main className="app-message">
      {review.status === "loading" ? <p role="status">Loading commit history…</p> : <p role="alert">{review.message}</p>}
    </main>
  );
}
