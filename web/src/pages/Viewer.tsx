import { useEffect, useState } from "react";
import { useRepoReview } from "../appFlow/hooks/useRepoReview";
import { useReviewData } from "../appFlow/hooks/useReviewData";
import type { ReviewData } from "../appFlow/hooks/useReviewData";
import { AppLink } from "../AppLink";
import { replaceDirectionOverride, replaceViewOverride } from "../view";
import { CodePane } from "../views/CodePane";
import { FlagsmithPanel } from "../views/FlagsmithPanel";
import { FlowLegend } from "../views/FlowCanvas";
import { FlowSourceDivider } from "../views/FlowSourceDivider";
import { Overlay } from "../views/Overlay";
import { OverlaySummary } from "../views/OverlaySummary";
import { ReviewBar } from "../views/ReviewBar";
import { SideBySide } from "../views/SideBySide";
import { Timeline } from "../views/Timeline";
import { DirectionPreview, VariantPreview, flowDirectionLabels, flowViewLabels } from "../views/VariantPreview";
import { formatCommitDate, formatFunctionCounts } from "../views/timelineHelpers";
import { displaySubdir } from "./importHelpers";

const neighboursHint = "How many callers/callees around the changed functions to show";

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
        <li>A → B means A calls B. A label like <code>fast_path: on</code> shows when that call runs.</li>
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

function RepoReview({ id, initial, search }: { id: string; initial: ReviewData; search: string }) {
  const {
    name, subdir, url, hasNodes, commits, selected, head, commitTitle, selectCommit, commitHref, nextChange,
    refresh, checkForNewCommits, flowChanged, view, viewOverride, assignedView, viewSource, direction,
    directionOverride, assignedDirection, directionSource, directionReady, longFlow, flagsReady, variantPreview,
    hops, setHops, request, layout, currentLayout, hasCollapsedContext, contextExpanded, toggleContext,
    expandModule, layoutPositions, fullscreen, markRendered, guideOpen, setGuide, guideButton, reviewContext,
    sendsReviewEvents, onReview, reviewKey, diff, selectedNode, selectNode, selectedCheck, openCheck,
    clearSelection, sourceOpen, setSourceOpen, workspace, sourceHeading, findings, flags, flagsmithMode,
    liveStates, selectedFlag, selectFlag,
  } = useRepoReview(id, search, initial);
  const View = view === "side_by_side" ? SideBySide : Overlay;

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
                onClick={toggleContext}
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
          {hasNodes && request.status === "loading" && (
            <p className="panel-message" role="status">Loading flow diff…</p>
          )}
          {request.status === "error" && <p className="panel-message" role="alert">{request.message}</p>}
          {diff && layout.status === "loading" && (
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
              key={reviewKey}
              context={reviewContext}
              sendsReviewEvents={sendsReviewEvents}
              onReview={onReview}
            />
          )}
        </section>
        <FlowSourceDivider workspace={workspace} sourceHeading={sourceHeading} hidden={!sourceOpen || fullscreen.active} />
        <CodePane repo={id} head={head} node={selectedNode} check={selectedCheck} headingRef={sourceHeading}
          nodes={diff?.nodes ?? []} open={sourceOpen} onSelect={selectNode}
          onClear={clearSelection} onOpenChange={setSourceOpen} />
        <FlagsmithPanel
          view={{ value: flowViewLabels[view], source: viewSource }}
          direction={{ value: flowDirectionLabels[direction], source: directionSource }}
          enabled={flagsmithMode}
          data={flags}
          error={findings.status === "error" ? findings.message : undefined}
          loading={Boolean(head) && findings.status === "loading"}
          selected={selectedFlag?.name}
          onSelect={selectFlag}
          onOpenCheck={openCheck}
        />
      </div>
    </main>
  );
}

export function Viewer({ id, search }: { id: string; search: string }) {
  const review = useReviewData(id);

  if (review.status === "ready") return <RepoReview id={id} search={search} initial={review.data} />;
  return (
    <main className="app-message">
      {review.status === "loading" ? <p role="status">Loading commit history…</p> : <p role="alert">{review.message}</p>}
    </main>
  );
}
