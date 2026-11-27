import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCommits, fetchRepos, fetchSnapshot, refreshRepo } from "../api";
import { AppLink } from "../AppLink";
import { recordReviewEvent } from "../events";
import { directionExposureKey, readFlowDirection, useCodeFlowFlags, useDirectionExposure } from "../flags";
import type { FlowLayout } from "../layout/elk";
import { pollRepoStatus } from "../pollRepoStatus";
import { navigate, repoPath } from "../router";
import type { FlagCheck, FlagFinding, OverlayNode, TimelineCommit } from "../types";
import { useDiff, useDiffLayout } from "../useDiff";
import type { Hops } from "../useDiff";
import { useRepoFlags } from "../useRepoFlags";
import { useRequest } from "../useRequest";
import { parseFlowDirection, parseFlowView, replaceDirectionOverride, replaceSyncOverride, replaceViewOverride } from "../view";
import type { FlowDirection, FlowView } from "../view";
import { CodePane } from "../views/CodePane";
import { FlagsmithPanel } from "../views/FlagsmithPanel";
import { FlowLegend } from "../views/FlowCanvas";
import { FlowSourceDivider } from "../views/FlowSourceDivider";
import { Overlay } from "../views/Overlay";
import { OverlaySummary } from "../views/OverlaySummary";
import { ReviewBar } from "../views/ReviewBar";
import { SideBySide } from "../views/SideBySide";
import { Timeline } from "../views/Timeline";
import { DirectionPreview, SyncPreview, VariantPreview, flowDirectionLabels, flowViewLabels } from "../views/VariantPreview";
import type { ExpandedContext } from "../views/collapse";
import { liveFlagStates, toggleFlagSelection } from "../views/flagFindings";
import { useDiagramFullscreen } from "../views/fullscreen";
import { layoutPositionKey, useLayoutPositions } from "../views/layoutPositions";
import {
  formatCommitDate, formatFunctionCounts, hasFlowChange, nearestFlowChange, resolveCommit,
} from "../views/timelineHelpers";
import { displaySubdir, importProgress } from "./importHelpers";

const guidePreference = "code-flow:diagram-guide";
const sourcePreference = "code-flow:source-code";
const neighboursHint = "How many callers/callees around the changed functions to show";

function readPanelPreference(key: string) {
  try {
    return window.localStorage.getItem(key) !== "closed";
  } catch {
    return true;
  }
}

function savePanelPreference(key: string, open: boolean) {
  try {
    window.localStorage.setItem(key, open ? "open" : "closed");
  } catch {
    // Toggling a panel still works when storage is blocked.
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

async function loadReview(id: string, signal: AbortSignal) {
  const [history, repos] = await Promise.all([fetchCommits(id, signal), fetchRepos(signal)]);
  const repo = repos.find((entry) => entry.id === id);
  const hasNodes = await hasNonemptySnapshot(id, history.commits, signal);
  return {
    commits: history.commits, name: repo?.name ?? history.repo, subdir: repo?.subdir ?? null,
    url: repo?.url ?? null, hasNodes,
  };
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

type ReviewData = Awaited<ReturnType<typeof loadReview>>;
type RefreshState =
  | { status: "running"; text: string }
  | { status: "ready" | "error"; text: string; head: string | undefined };
const checkingCommits = "Checking for new commits…";

function pinCurrentCommit(commits: TimelineCommit[]) {
  const location = new URL(window.location.href);
  if (location.searchParams.has("commit")) return location.searchParams.get("commit");
  const current = resolveCommit(commits, null);
  if (!current) return null;
  location.searchParams.set("commit", current.sha);
  navigate(location.href, { replace: true });
  return current.sha;
}

function RepoReview({ id, initial, search }: { id: string; initial: ReviewData; search: string }) {
  const [review, setReview] = useState(initial);
  const { name, subdir, url, hasNodes, commits } = review;
  const {
    flowView: view, reviewerId, viewOverride, directionOverride, syncOverride, variantPreview, flagsmithMode,
    syncMode, assignedSyncMode,
    ready: flagsReady, assignedView, reviewEventClient, directionFlag,
  } = useCodeFlowFlags(search);
  const selected = resolveCommit(commits, new URLSearchParams(search).get("commit"));
  const head = selected?.sha;
  const [refresh, setRefresh] = useState<RefreshState | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  if (refresh && refresh.status !== "running" && refresh.head !== head) setRefresh(null);
  useEffect(() => () => refreshRequest.current?.abort(), []);
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
  const [guideOpen, setGuideOpen] = useState(() => readPanelPreference(guidePreference));
  const [sourceOpen, setSourceOpen] = useState(() => readPanelPreference(sourcePreference));
  const guideButton = useRef<HTMLButtonElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const sourceHeading = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<{ head: string | undefined; expanded: ExpandedContext }>(
    () => ({ head, expanded: new Set() }),
  );
  if (context.head !== head) setContext({ head, expanded: new Set() });
  const [selection, setSelection] = useState<
    { head: string; nodeId: string } | { head: string; check: FlagCheck } | null
  >(null);
  const [rendered, setRendered] = useState<{
    layout: FlowLayout; view: FlowView; direction: FlowDirection;
  } | null>(null);
  const request = useDiff(id, hasNodes ? head : undefined, hops);
  const diff = request.status === "ready" ? request.data : null;
  const longFlow = diff ? diff.long_flow === true : undefined;
  const { direction, assignedDirection, ready: directionReady } = readFlowDirection(
    directionOverride, longFlow, directionFlag,
  );
  const { layout, hasCollapsedContext } = useDiffLayout(
    diff, context.expanded, view === "side_by_side", flagsReady && directionReady ? direction : null, checkIds,
  );
  const currentLayout = layout.status === "ready" ? layout.data : null;
  const layoutPositions = useLayoutPositions(layoutPositionKey(id, head ?? "", view, direction));
  const contextExpanded = context.expanded === "all" || context.expanded.size > 0;
  const currentSelection = selection?.head === head ? selection : null;
  const selectedNode = currentSelection && "nodeId" in currentSelection
    ? diff?.nodes.find(({ id }) => id === currentSelection.nodeId) : undefined;
  const selectedCheck = currentSelection && "check" in currentSelection ? currentSelection.check : undefined;
  const markRendered = useCallback(() => {
    if (currentLayout) setRendered({ layout: currentLayout, view, direction });
  }, [currentLayout, view, direction]);
  const diagramRendered = Boolean(currentLayout && rendered?.layout === currentLayout
    && rendered.view === view && rendered.direction === direction);
  const previewOverride = viewOverride ?? directionOverride ?? syncOverride;
  const exposureKey = directionExposureKey(reviewerId, longFlow, previewOverride, directionFlag);
  const layoutReview = useDirectionExposure(reviewerId, exposureKey, diagramRendered);
  const reviewContext = diff && diagramRendered && layoutReview.ready
    ? { repo: id, view, reviewerId, head: diff.head, base: diff.base, devOverride: previewOverride !== null }
    : null;
  const View = view === "side_by_side" ? SideBySide : Overlay;
  const flowChanged = selected && hasFlowChange(selected.stats);
  const fullscreen = useDiagramFullscreen(Boolean(flowChanged && layout.status === "ready" && layout.data?.nodes.length));
  const nextChange = selected && !flowChanged ? nearestFlowChange(commits, selected.sha) : null;
  const viewSource = variantPreview && parseFlowView(viewOverride) ? "Preview"
    : !flagsReady ? "Loading assignment…" : assignedView ? "Assigned by Flagsmith" : "Default";
  const directionSource = variantPreview && parseFlowDirection(directionOverride) ? "Preview"
    : assignedDirection ? "Assigned by Flagsmith" : longFlow === false ? "Default for short flows" : "Default";

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
      setSelection(null);
      navigate(commitHref(sha));
    }
  }, [commitHref, head]);

  async function checkForNewCommits() {
    if (refreshRequest.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    refreshRequest.current = controller;
    setRefresh({ status: "running", text: checkingCommits });
    try {
      const job = await refreshRepo(id, signal);
      const status = await pollRepoStatus(job.id, signal, (update) => {
        const progress = importProgress(job.status, update);
        if (update.status === "analyzing" && progress.progress) {
          setRefresh({ status: "running", text: progress.text });
        }
      });
      if (status.status === "error") throw new Error(importProgress(job.status, status).text);

      pinCurrentCommit(commits);
      const updated = await loadReview(id, signal);
      if (signal.aborted) return;
      // The reviewer can navigate while the new history loads.
      const next = resolveCommit(updated.commits, pinCurrentCommit(commits));
      // A refresh can join a regular import, which has no refresh count.
      const oldShas = new Set(commits.map(({ sha }) => sha));
      const count = status.new_commits ?? updated.commits.filter(({ sha }) => !oldShas.has(sha)).length;
      const text = count === 0 ? "Up to date" : `${count} new commit${count === 1 ? "" : "s"}`;
      setReview(updated);
      setRefresh({ status: "ready", head: next?.sha, text });
    } catch (error) {
      if (!signal.aborted) {
        const current = resolveCommit(commits, new URLSearchParams(window.location.search).get("commit"));
        const detail = error instanceof Error ? error.message : "Something went wrong.";
        setRefresh({ status: "error", head: current?.sha, text: `Couldn't check for new commits: ${detail}` });
      }
    } finally {
      refreshRequest.current = null;
    }
  }

  function setGuide(open: boolean) {
    setGuideOpen(open);
    savePanelPreference(guidePreference, open);
  }

  function selectNode(node: OverlayNode) {
    if (head) setSelection({ head, nodeId: node.id });
    setSourceOpen(true);
  }

  function expandModule(module: string) {
    setContext(({ expanded }) => ({
      head, expanded: expanded === "all" ? expanded : new Set([...expanded, module]),
    }));
  }

  const commitTitle = selected?.message || "Untitled commit";

  return (
    <main className="viewer">
      <header className="viewer-header">
        <div className="viewer-header__details">
          <div className="viewer-header__repo">
            <h1 title={name}>{name}</h1>
            {subdir && (
              <p className="viewer-header__subdir" title={displaySubdir(subdir)}>
                Subfolder <code>{displaySubdir(subdir)}</code>
              </p>
            )}
          </div>
          {selected && (
            <div className="viewer-header__commit">
              <h2 title={commitTitle}>{commitTitle}</h2>
              <div className="commit-meta">
                {selected.author && <span title={selected.author}>{selected.author}</span>}
                <time dateTime={selected.date}>{formatCommitDate(selected.date)}</time>
                <code title={selected.sha}>{selected.sha.slice(0, 7)}</code>
                <span className="commit-meta__counts">{formatFunctionCounts(selected.stats)}</span>
              </div>
            </div>
          )}
        </div>
        <div className="viewer-header__controls">
          {url?.startsWith("https://github.com/") && (
            <div className="commit-refresh">
              <button type="button" className="btn btn--sm" disabled={refresh?.status === "running"}
                onClick={checkForNewCommits}>Check for new commits</button>
              {refresh && (
                <span role={refresh.status === "error" ? "alert" : "status"}>{refresh.text}</span>
              )}
            </div>
          )}
          {variantPreview && (
            <VariantPreview view={view} viewOverride={viewOverride} assignedView={assignedView}
              ready={flagsReady} onChange={replaceViewOverride} />
          )}
          {variantPreview && hasNodes && head && (
            <DirectionPreview direction={direction} directionOverride={directionOverride}
              assignedDirection={assignedDirection} longFlow={longFlow}
              ready={directionReady} onChange={replaceDirectionOverride} />
          )}
          {variantPreview && (
            <SyncPreview mode={syncMode} override={syncOverride} assignedMode={assignedSyncMode}
              onChange={replaceSyncOverride} />
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
      <div ref={workspace} className={sourceOpen ? "workspace" : "workspace workspace--code-collapsed"}>
        <Timeline commits={commits} selectedSha={head} onSelect={selectCommit} />
        <section className={fullscreen.maximized ? "graph-panel graph-panel--maximized" : "graph-panel"}
          aria-labelledby="flow-title" ref={fullscreen.panel}>
          <div className="panel-heading">
            <h2 id="flow-title">Flow</h2>
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
                    onNodeClick={selectNode}
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
              onReview={(payload) => recordReviewEvent(payload, reviewEventClient, layoutReview)}
            />
          )}
        </section>
        <FlowSourceDivider workspace={workspace} sourceHeading={sourceHeading} hidden={!sourceOpen || fullscreen.active} />
        <CodePane repo={id} head={head} node={selectedNode} check={selectedCheck} headingRef={sourceHeading}
          nodes={diff?.nodes ?? []} open={sourceOpen} onSelect={selectNode}
          onClear={() => setSelection(null)} onOpenChange={(open) => {
            setSourceOpen(open);
            savePanelPreference(sourcePreference, open);
          }} />
        <FlagsmithPanel
          view={{ value: flowViewLabels[view], source: viewSource }}
          direction={{ value: flowDirectionLabels[direction], source: directionSource }}
          enabled={flagsmithMode}
          data={flags}
          error={findings.status === "error" ? findings.message : undefined}
          loading={Boolean(head) && findings.status === "loading"}
          selected={selectedFlag?.name}
          onSelect={(finding) => {
            const name = toggleFlagSelection(selectedFlag?.name, finding.name);
            setFlagSelection(name ? { head, finding } : undefined);
          }}
          onOpenCheck={(check) => {
            if (head) setSelection({ head, check });
            setSourceOpen(true);
          }}
        />
      </div>
    </main>
  );
}

export function Viewer({ id, search }: { id: string; search: string }) {
  const request = useCallback((signal: AbortSignal) => loadReview(id, signal), [id]);
  const review = useRequest(request);

  if (review.status === "ready") return <RepoReview id={id} search={search} initial={review.data} />;
  return (
    <main className="app-message">
      {review.status === "loading" ? <p role="status">Loading commit history…</p> : <p role="alert">{review.message}</p>}
    </main>
  );
}
