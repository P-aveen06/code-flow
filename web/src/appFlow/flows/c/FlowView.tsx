// Flow C "Canvas": the flow view. The diagram fills the screen under the top bar, and floating
// panels sit over it: the commit card with the branch switch, the controls, the review question,
// the source code of the selected function, the changed functions and the commit scrubber.
// Data and handlers come from useRepoReview; the diagram is today's Overlay or SideBySide.
// Layout lives in flowview.css; colours, type and button shapes come from the tokens.
import { useEffect, useId, useRef, useState } from "react";
import { AppLink } from "../../../AppLink";
import type { ReviewContext, ReviewEvent } from "../../../events";
import { displaySubdir } from "../../../pages/importHelpers";
import { githubReposPath } from "../../../router";
import type { DiffStats, OverlayNode, TimelineCommit } from "../../../types";
import { replaceDirectionOverride, replaceViewOverride } from "../../../view";
import { ChangedFunctions, CodePane } from "../../../views/CodePane";
import { FlagsmithPanel } from "../../../views/FlagsmithPanel";
import { FlowLegend } from "../../../views/FlowCanvas";
import { Overlay } from "../../../views/Overlay";
import { OverlaySummary } from "../../../views/OverlaySummary";
import { SideBySide } from "../../../views/SideBySide";
import { DirectionPreview, VariantPreview, flowDirectionLabels, flowViewLabels } from "../../../views/VariantPreview";
import {
  filterTimeline, formatCommitDate, formatFunctionCounts, formatStats, hasFlowChange, moveSelection,
} from "../../../views/timelineHelpers";
import { useMe } from "../../hooks/useMe";
import { useRepoReview } from "../../hooks/useRepoReview";
import { useReviewData } from "../../hooks/useReviewData";
import type { ReviewData } from "../../hooks/useReviewData";
import { useReviewQuestion } from "../../hooks/useReviewQuestion";
import { BranchSwitchScreen } from "../../screens";
import { Button } from "../../ui/Button";
import { AvatarMenu, CanvasBackground, FloatingPanel, Header, Icon, Pill } from "./kit";
import "./flowview.css";

type Account = ReturnType<typeof useMe>;

export function FlowViewC({ id, search }: { id: string; search: string }) {
  const review = useReviewData(id);
  const account = useMe();
  if (review.status === "ready") {
    return <RepoReview id={id} search={search} initial={review.data} account={account} />;
  }
  return (
    <main className="fc-flow">
      <FlowHeader account={account} />
      {review.status === "loading"
        ? <p className="fc-flow__message" role="status">Loading commit history…</p>
        : <p className="fc-flow__message" role="alert">{review.message}</p>}
    </main>
  );
}

function FlowHeader({ account }: { account: Account }) {
  const { me, signOut } = account;
  return (
    <Header right={me.status === "ready" ? <AvatarMenu me={me.data} onSignOut={() => void signOut()} /> : undefined}>
      <span className="fc-flow__divider" aria-hidden="true" />
      <AppLink href={githubReposPath} className="fc-flow__repos">Your repositories</AppLink>
    </Header>
  );
}

function isChangedFunction({ kind, status }: OverlayNode) {
  return (kind === "function" || kind === "method") && status !== "context";
}

function RepoReview({ id, initial, search, account }: {
  id: string;
  initial: ReviewData;
  search: string;
  account: Account;
}) {
  const m = useRepoReview(id, search, initial);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const neighboursId = useId();
  const guideId = useId();
  const View = m.view === "side_by_side" ? SideBySide : Overlay;
  const sourceShown = Boolean(m.selectedNode || m.selectedCheck);
  // With source code open, the diagram keeps clear of the right column.
  const narrow = sourceShown && m.sourceOpen;
  const changedCount = m.diff ? m.diff.nodes.filter(isChangedFunction).length : 0;
  const neighboursHint = "How many callers/callees around the changed functions to show";

  return (
    <main className="fc-flow">
      <FlowHeader account={account} />
      <section
        ref={m.fullscreen.panel}
        className={m.fullscreen.maximized ? "fc-flow__stage fc-flow__stage--maximized" : "fc-flow__stage"}
        aria-label="Flow"
      >
        <CanvasBackground className="fc-flow__canvas">
          <div className="fc-flow__body">
            <div className={narrow ? "fc-flow__graph fc-flow__graph--narrow" : "fc-flow__graph"}>
              <div className="fc-flow__diagram">
                <div className="flow-comparison">
                  {m.diff && m.currentLayout && m.flowChanged && (
                    <View
                      key={`${m.view}:${m.direction}`}
                      diff={m.diff}
                      layout={m.currentLayout}
                      direction={m.direction}
                      layoutPositions={m.layoutPositions}
                      fullscreen={m.fullscreen}
                      selectedNodeId={m.selectedNode?.id}
                      selectedFlag={m.selectedFlag}
                      liveStates={m.liveStates}
                      onNodeClick={m.selectNode}
                      onExpandModule={m.expandModule}
                      onReady={m.markRendered}
                    />
                  )}
                </div>
                {m.diff && m.currentLayout && m.flowChanged && (
                  <div className="fc-flow__legend-row">
                    <FlowLegend flagsmithMode={m.flagsmithMode} />
                  </div>
                )}
              </div>

              {m.diff && m.currentLayout && !m.flowChanged && (
                <NoFlowChange
                  next={m.nextChange && { href: m.commitHref(m.nextChange.sha), direction: m.nextChange.direction }}
                  onReady={m.markRendered}
                />
              )}
              {!m.hasNodes && (
                <p className="fc-flow__notice">
                  No Python code found in {m.subdir ? displaySubdir(m.subdir) : "this repository"}. code-flow analyzes Python only for now.
                </p>
              )}
              {m.hasNodes && m.request.status === "loading" && (
                <p className="fc-flow__notice" role="status">Loading flow diff…</p>
              )}
              {m.request.status === "error" && <p className="fc-flow__notice" role="alert">{m.request.message}</p>}
              {m.diff && m.layout.status === "loading" && (
                <p className="fc-flow__notice" role="status">Laying out the flow…</p>
              )}
              {m.diff && m.layout.status === "error" && (
                <p className="fc-flow__notice" role="alert">Could not lay out the flow. {m.layout.message}</p>
              )}

              <FloatingPanel className="fc-flow__commit">
                <div className="fc-flow__commit-head">
                  <h1 className="fc-flow__repo" title={m.name}>{m.name}</h1>
                  <button
                    type="button"
                    className="fc-flow__icon"
                    aria-label="Flagsmith details"
                    title="Flagsmith details"
                    aria-expanded={detailsOpen}
                    aria-controls={detailsId}
                    onClick={() => setDetailsOpen(!detailsOpen)}
                  >
                    <Icon name="info" size={16} />
                  </button>
                </div>
                <div className="fc-flow__chips">
                  {m.subdir && <span className="fc-flow__subdir" title="Subfolder">{displaySubdir(m.subdir)}</span>}
                  <BranchSwitchScreen repoId={id} currentBranch={m.branch} />
                </div>
                {m.selected && (
                  <>
                    <h2 className="fc-flow__commit-title" title={m.commitTitle}>{m.commitTitle}</h2>
                    <div className="fc-flow__meta">
                      {m.selected.author && (
                        <>
                          <span title={m.selected.author}>{m.selected.author}</span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
                      <time dateTime={m.selected.date}>{formatCommitDate(m.selected.date)}</time>
                      <code title={m.selected.sha}>{m.selected.sha.slice(0, 7)}</code>
                    </div>
                    <StatPills stats={m.selected.stats} />
                  </>
                )}
                {m.diff && (
                  <div className="fc-flow__range">
                    <span>Compared range</span>
                    <code title={`${m.diff.base || "Empty graph"} → ${m.diff.head}`}>
                      {m.diff.base ? m.diff.base.slice(0, 7) : "Empty graph"} → {m.diff.head.slice(0, 7)}
                    </code>
                  </div>
                )}
                {m.diff && m.view === "overlay_summary" && <OverlaySummary summary={m.diff.summary} />}
                {detailsOpen && (
                  <div id={detailsId} className="fc-flow__details">
                    {m.variantPreview && (
                      <VariantPreview
                        view={m.view}
                        viewOverride={m.viewOverride}
                        assignedView={m.assignedView}
                        ready={m.flagsReady}
                        onChange={replaceViewOverride}
                      />
                    )}
                    {m.variantPreview && m.hasNodes && m.head && (
                      <DirectionPreview
                        direction={m.direction}
                        directionOverride={m.directionOverride}
                        assignedDirection={m.assignedDirection}
                        longFlow={m.longFlow}
                        ready={m.directionReady}
                        onChange={replaceDirectionOverride}
                      />
                    )}
                    <FlagsmithPanel
                      view={{ value: flowViewLabels[m.view], source: m.viewSource }}
                      direction={{ value: flowDirectionLabels[m.direction], source: m.directionSource }}
                      enabled={m.flagsmithMode}
                      data={m.flags}
                      error={m.findings.status === "error" ? m.findings.message : undefined}
                      loading={Boolean(m.head) && m.findings.status === "loading"}
                      selected={m.selectedFlag?.name}
                      onSelect={m.selectFlag}
                      onOpenCheck={m.openCheck}
                    />
                  </div>
                )}
              </FloatingPanel>

              <div className="fc-flow__top">
                <div className="fc-flow__toolbar">
                  {m.hasNodes && (
                    <div className="fc-flow__neighbours" title={neighboursHint}>
                      <span id={neighboursId} className="fc-flow__toolbar-label">Show neighbours</span>
                      <div
                        className="fc-flow__segmented"
                        role="group"
                        aria-labelledby={neighboursId}
                        aria-description={neighboursHint}
                      >
                        {([1, 2] as const).map((option) => (
                          <button
                            key={option}
                            type="button"
                            className="fc-flow__segment"
                            aria-pressed={m.hops === option}
                            onClick={() => m.setHops(option)}
                          >
                            {option} {option === 1 ? "step" : "steps"}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {m.diff && m.flowChanged && (m.hasCollapsedContext || m.contextExpanded) && (
                    <>
                      <span className="fc-flow__sep" aria-hidden="true" />
                      <button type="button" className="fc-flow__tool" onClick={m.toggleContext}>
                        {m.hasCollapsedContext ? "Expand all context" : "Collapse context"}
                      </button>
                    </>
                  )}
                  {m.url?.startsWith("https://github.com/") && (
                    <>
                      <span className="fc-flow__sep" aria-hidden="true" />
                      <div className="fc-flow__refresh">
                        <button
                          type="button"
                          className="fc-flow__tool"
                          disabled={m.refresh?.status === "running"}
                          onClick={m.checkForNewCommits}
                        >
                          <Icon name="refresh" size={14} />
                          Check for new commits
                        </button>
                        {m.refresh && (
                          <span className="fc-flow__refresh-text" role={m.refresh.status === "error" ? "alert" : "status"}>
                            {m.refresh.text}
                          </span>
                        )}
                      </div>
                    </>
                  )}
                  {m.hasNodes && (
                    <>
                      <span className="fc-flow__sep" aria-hidden="true" />
                      <button
                        ref={m.guideButton}
                        type="button"
                        className="fc-flow__icon"
                        aria-label="What am I looking at?"
                        aria-expanded={m.guideOpen}
                        aria-controls={m.guideOpen ? guideId : undefined}
                        title="What am I looking at?"
                        onClick={() => m.setGuide(!m.guideOpen)}
                      >
                        <Icon name="help" size={16} />
                      </button>
                    </>
                  )}
                </div>
                {m.hasNodes && m.guideOpen && (
                  <DiagramGuide
                    id={guideId}
                    onDismiss={() => {
                      m.setGuide(false);
                      m.guideButton.current?.focus();
                    }}
                  />
                )}
              </div>

              {m.diff && m.flowChanged && !sourceShown && (
                <FloatingPanel className="fc-flow__changed">
                  <details key={m.head} open={changedCount <= 6}>
                    <summary className="fc-flow__changed-summary">Changed functions</summary>
                    <ChangedFunctions nodes={m.diff.nodes} onSelect={m.selectNode} />
                  </details>
                </FloatingPanel>
              )}
            </div>

            <aside className="fc-flow__side" aria-label="Review and source code">
              {m.hasNodes && m.head && (
                <ReviewQuestion
                  key={m.reviewKey}
                  context={m.reviewContext}
                  sendsReviewEvents={m.sendsReviewEvents}
                  onReview={m.onReview}
                />
              )}
              {sourceShown && (
                <div className="fc-flow__source">
                  <CodePane
                    repo={id}
                    head={m.head}
                    node={m.selectedNode}
                    check={m.selectedCheck}
                    headingRef={m.sourceHeading}
                    nodes={m.diff?.nodes ?? []}
                    open={m.sourceOpen}
                    onSelect={m.selectNode}
                    onClear={m.clearSelection}
                    onOpenChange={m.setSourceOpen}
                  />
                </div>
              )}
            </aside>
          </div>

          <CommitScrubber commits={m.commits} head={m.head} hrefOf={m.commitHref} onSelect={m.selectCommit} />
        </CanvasBackground>
      </section>
    </main>
  );
}

function StatPills({ stats }: { stats: DiffStats }) {
  const text = formatStats(stats);
  return (
    <div className="fc-flow__counts" role="group" aria-label={formatFunctionCounts(stats)}>
      <Pill tone="added">{text.added}</Pill>
      <Pill tone="removed">{text.removed}</Pill>
      <Pill tone="changed">{text.changed}</Pill>
    </div>
  );
}

function DiagramGuide({ id, onDismiss }: { id: string; onDismiss(): void }) {
  const [more, setMore] = useState(false);
  const titleId = useId();
  const detailsId = useId();

  return (
    <aside id={id} className="fc-flow__guide" aria-labelledby={titleId}>
      <div className="fc-flow__guide-head">
        <Icon name="help" size={16} />
        <h2 id={titleId} className="fc-flow__guide-title">What am I looking at?</h2>
        <Button variant="tertiary" size="sm" aria-expanded={more} aria-controls={detailsId} onClick={() => setMore(!more)}>
          {more ? "Less" : "More"}
        </Button>
        <button type="button" className="fc-flow__icon" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <p className="fc-flow__guide-text">Boxes show Python symbols and arrows show calls. Click a symbol to read its code.</p>
      <ul id={detailsId} className="fc-flow__guide-more" hidden={!more}>
        <li>Symbols are grouped by module. Click a context chip to expand its module.</li>
        <li>A → B means A calls B. A label like <code>fast_path: on</code> shows when that call runs.</li>
        <li>Use <kbd>↑</kbd> and <kbd>↓</kbd> to step through commits.</li>
      </ul>
    </aside>
  );
}

function ReviewQuestion({ context, sendsReviewEvents, onReview }: {
  context: ReviewContext | null;
  sendsReviewEvents: boolean;
  onReview: (payload: ReviewEvent) => void;
}) {
  const { canReview, answered, submit } = useReviewQuestion(context, onReview);

  return (
    <FloatingPanel title="Did this diagram help you understand the change?">
      {answered ? (
        <p className="fc-flow__thanks" role="status">Thanks — recorded.</p>
      ) : (
        <div className="fc-flow__answers">
          <Button
            variant="secondary"
            size="sm"
            className="fc-flow__answer"
            aria-keyshortcuts="U"
            disabled={!canReview}
            onClick={() => submit("diff_understood")}
          >
            Yes, I understand it <kbd>U</kbd>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="fc-flow__answer"
            aria-keyshortcuts="C"
            disabled={!canReview}
            onClick={() => submit("diff_confusing")}
          >
            No, it's confusing <kbd>C</kbd>
          </Button>
        </div>
      )}
      <p className="fc-flow__note">
        {sendsReviewEvents
          ? "Your answer feeds a Flagsmith A/B test of how code-flow shows diffs."
          : "Your answer stays local."}
      </p>
    </FloatingPanel>
  );
}

function NoFlowChange({ next, onReady }: {
  next: { href: string; direction: string } | null;
  onReady: () => void;
}) {
  useEffect(onReady, [onReady]);

  return (
    <div className="fc-flow__nochange">
      <span className="fc-flow__nochange-icon" aria-hidden="true">
        <Icon name="branch" size={22} />
      </span>
      <h2 className="fc-flow__nochange-title">No flow change</h2>
      <p className="fc-flow__nochange-text">
        This commit didn't change any Python functions or calls (it may touch tests, docs, migrations or other languages).
      </p>
      {next && (
        <Button variant="primary" to={next.href}>
          Go to the {next.direction} commit with flow changes <Icon name="arrow-right" size={16} />
        </Button>
      )}
    </div>
  );
}

// One dot per commit, newest on the left. Its size shows how much changed; a commit with no flow
// change is a small grey tick, and the selected commit is the blue ring.
function dotClass(stats: DiffStats, current: boolean) {
  if (current) return "fc-flow__dot fc-flow__dot--selected";
  if (!hasFlowChange(stats)) return "fc-flow__dot fc-flow__dot--tick";
  const changed = stats.nodes_added + stats.nodes_removed + stats.nodes_changed;
  if (changed <= 2) return "fc-flow__dot fc-flow__dot--s";
  return changed <= 9 ? "fc-flow__dot fc-flow__dot--m" : "fc-flow__dot fc-flow__dot--l";
}

function CommitScrubber({ commits, head, hrefOf, onSelect }: {
  commits: TimelineCommit[];
  head: string | undefined;
  hrefOf(sha: string): string;
  onSelect(sha: string): void;
}) {
  const [hideUnchanged, setHideUnchanged] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);
  const { visible, hiddenCount } = filterTimeline(commits, head, hideUnchanged);
  const selectedIndex = visible.findIndex(({ sha }) => sha === head);
  const selected = commits.find(({ sha }) => sha === head);
  // The rail runs newest to oldest, the reverse of the order `visible` keeps.
  const ordered = [...visible].reverse();

  // ↑ and ↓ move to the older and newer commit, as they do in the commit list.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;

      const nextIndex = moveSelection(selectedIndex, event.key, visible.length);
      if (nextIndex === -1) return;
      event.preventDefault();
      if (nextIndex === selectedIndex) return;
      const list = listRef.current;
      if (list?.contains(document.activeElement)) {
        list.querySelectorAll("a")[visible.length - 1 - nextIndex]?.focus({ preventScroll: true });
      }
      onSelect(visible[nextIndex].sha);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIndex, visible, onSelect]);

  return (
    <div className="fc-flow__bottom">
      <div className="fc-flow__scrub">
        <div className="fc-flow__scrub-head">
          {selected && (
            <>
              <code title={selected.sha}>{selected.sha.slice(0, 7)}</code>
              {selected.author && (
                <>
                  <span aria-hidden="true">·</span>
                  <span title={selected.author}>{selected.author}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <time dateTime={selected.date}>{formatCommitDate(selected.date)}</time>
              <StatPills stats={selected.stats} />
            </>
          )}
          <label className="fc-flow__hide">
            <input type="checkbox" checked={hideUnchanged} onChange={(event) => setHideUnchanged(event.target.checked)} />
            Hide commits with no flow change
          </label>
          {hideUnchanged && hiddenCount > 0 && (
            <span className="fc-flow__hidden" aria-live="polite">{hiddenCount} hidden</span>
          )}
        </div>
        {selected && <p className="fc-flow__scrub-title">{selected.message || "Untitled commit"}</p>}
        {commits.length > 0 ? (
          <ol className="fc-flow__dots" aria-label="Commits" ref={listRef}>
            {ordered.map((commit) => {
              const current = commit.sha === head;
              const label = `${commit.sha.slice(0, 7)} ${commit.message}`;
              return (
                <li key={commit.sha}>
                  <a
                    href={hrefOf(commit.sha)}
                    className="fc-flow__dot-button"
                    title={label}
                    aria-label={label}
                    aria-current={current ? "true" : undefined}
                    tabIndex={current ? 0 : -1}
                    onClick={(event) => {
                      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                      event.preventDefault();
                      onSelect(commit.sha);
                    }}
                  >
                    <span className={dotClass(commit.stats, current)} />
                  </a>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="fc-flow__scrub-title">No commits available.</p>
        )}
        <div className="fc-flow__scrub-labels">
          <span>Newest</span>
          <span><kbd>↑</kbd> <kbd>↓</kbd> Navigate commits</span>
          <span>Oldest</span>
        </div>
      </div>
    </div>
  );
}
