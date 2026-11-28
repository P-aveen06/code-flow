// Flow B "Workbench": the flow view as one dense screen, with every panel in view at 1440 x 900.
// It re-lays out today's RepoReview (pages/Viewer.tsx) on the same model: the same diagram, source,
// review question and Flagsmith panel, with the same props. The commit list, the summary and guide
// strips, the source dock and the inspector follow the B5 board.
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useMe } from "../../hooks/useMe";
import { useRepoReview } from "../../hooks/useRepoReview";
import type { RepoReviewModel } from "../../hooks/useRepoReview";
import { useReviewData } from "../../hooks/useReviewData";
import type { ReviewData } from "../../hooks/useReviewData";
import { useReviewQuestion } from "../../hooks/useReviewQuestion";
import { displaySubdir } from "../../../pages/importHelpers";
import type { DiffStats, FlagCheck, OverlayNode } from "../../../types";
import { replaceDirectionOverride, replaceViewOverride } from "../../../view";
import { ChangedFunctions, CodePane } from "../../../views/CodePane";
import { FlagsmithPanel } from "../../../views/FlagsmithPanel";
import { FlowLegend } from "../../../views/FlowCanvas";
import { FlowSourceDivider } from "../../../views/FlowSourceDivider";
import { Overlay } from "../../../views/Overlay";
import { OverlaySummary } from "../../../views/OverlaySummary";
import { SideBySide } from "../../../views/SideBySide";
import { statusLabels } from "../../../views/styles";
import { DirectionPreview, VariantPreview, flowDirectionLabels, flowViewLabels } from "../../../views/VariantPreview";
import { filterTimeline, formatCommitDate, formatFunctionCounts, formatStats, moveSelection } from "../../../views/timelineHelpers";
import { BranchSwitchScreen } from "../../screens";
import { Button } from "../../ui/Button";
import { Avatar, Header, Icon, Tabs } from "./kit";
import "./flowview.css";

export function FlowViewB({ id, search }: { id: string; search: string }) {
  const review = useReviewData(id);
  if (review.status === "ready") return <FlowWorkbench id={id} search={search} initial={review.data} />;
  return (
    <div className="fb-flowview">
      <Header />
      <main className="fb-flowview__message">
        {review.status === "loading"
          ? <p role="status">Loading commit history…</p>
          : <p role="alert">{review.message}</p>}
      </main>
    </div>
  );
}

type DockTab = "source" | "functions";

function FlowWorkbench({ id, search, initial }: { id: string; search: string; initial: ReviewData }) {
  const review = useRepoReview(id, search, initial);
  const account = useMe();
  const [dockTab, setDockTab] = useState<DockTab>("source");
  const me = account.me.status === "ready" ? account.me.data : null;

  // A chosen function or flag check shows its code, so the dock moves to the source tab.
  const selectNode = (node: OverlayNode) => {
    setDockTab("source");
    review.selectNode(node);
  };
  const openCheck = (check: FlagCheck) => {
    setDockTab("source");
    review.openCheck(check);
  };

  return (
    <div className="fb-flowview">
      <Header
        right={me?.signed_in
          ? <Account login={me.login} avatar={me.avatar_url} onSignOut={() => void account.signOut()} />
          : undefined}
      >
        <Crumbs id={id} name={review.name} subdir={review.subdir} branch={review.branch} />
      </Header>
      <CommitBar review={review} />
      <div className="fb-flowview__body">
        <CommitsPanel id={id} review={review} />
        <div
          ref={review.workspace}
          className={cx("fb-flowview__workspace", !review.sourceOpen && "fb-flowview__workspace--collapsed")}
        >
          <FlowArea review={review} onNodeClick={selectNode} />
          <FlowSourceDivider
            workspace={review.workspace}
            sourceHeading={review.sourceHeading}
            hidden={!review.sourceOpen || review.fullscreen.active}
          />
          <Dock id={id} review={review} tab={dockTab} onTab={setDockTab} onSelectNode={selectNode} />
        </div>
        <Inspector review={review} onOpenCheck={openCheck} />
      </div>
    </div>
  );
}

function Account({ login, avatar, onSignOut }: { login: string; avatar: string; onSignOut: () => void }) {
  return (
    <div className="fb-flowview__account">
      <Avatar login={login} src={avatar} />
      <span>@{login}</span>
      <Button variant="tertiary" onClick={onSignOut}>Sign out</Button>
    </div>
  );
}

// The top bar's path: repo, subfolder, and the branch switch. The commits sidebar has the same switch.
function Crumbs({ id, name, subdir, branch }: { id: string; name: string; subdir: string | null; branch: string }) {
  return (
    <nav className="fb-flowview__crumbs" aria-label="Repository and branch">
      <span className="fb-flowview__divider" aria-hidden="true" />
      <Icon name="repo" />
      {/* An imported branch is named repo@branch; the branch switch beside it shows the branch. */}
      <span className="fb-flowview__repo">{name.replace(/@.*$/, "")}</span>
      {subdir && (
        <>
          <span aria-hidden="true">/</span>
          <code>{displaySubdir(subdir)}</code>
        </>
      )}
      <span aria-hidden="true">/</span>
      <BranchSwitchScreen repoId={id} currentBranch={branch} />
    </nav>
  );
}

// The commit under review, the neighbours control and "Check for new commits", above the panels.
function CommitBar({ review }: { review: RepoReviewModel }) {
  const { name, selected, commitTitle, diff, hasNodes, hops, setHops, url, refresh, checkForNewCommits } = review;
  return (
    <div className="fb-flowview__commitbar">
      <div className="fb-flowview__commit">
        <h1 title={selected ? commitTitle : name}>{selected ? commitTitle : name}</h1>
        {selected && (
          <div className="fb-flowview__meta">
            {selected.author && <span title={selected.author}>{selected.author}</span>}
            <time dateTime={selected.date}>{formatCommitDate(selected.date)}</time>
            <code title={selected.sha}>{selected.sha.slice(0, 7)}</code>
            {diff && (
              <code title={`${diff.base || "Empty graph"} → ${diff.head}`}>
                {diff.base ? diff.base.slice(0, 7) : "Empty graph"} → {diff.head.slice(0, 7)}
              </code>
            )}
            <span className="fb-flowview__counts">{formatFunctionCounts(selected.stats)}</span>
          </div>
        )}
      </div>
      <div className="fb-flowview__controls">
        {hasNodes && (
          <div className="fb-flowview__neighbours" title="How many callers/callees around the changed functions to show">
            <span id="neighbours-label">Show neighbours:</span>
            <div className="fb-flowview__segmented" role="group" aria-labelledby="neighbours-label">
              {([1, 2] as const).map((option) => (
                <Button
                  key={option}
                  variant="tertiary"
                  size="sm"
                  className="fb-flowview__segment"
                  aria-pressed={hops === option}
                  onClick={() => setHops(option)}
                >
                  {option} {option === 1 ? "step" : "steps"}
                </Button>
              ))}
            </div>
          </div>
        )}
        {url?.startsWith("https://github.com/") && (
          <div className="fb-flowview__refresh">
            <Button disabled={refresh?.status === "running"} onClick={checkForNewCommits}>
              <Icon name="refresh" />
              Check for new commits
            </Button>
            {refresh && <span role={refresh.status === "error" ? "alert" : "status"}>{refresh.text}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// The left panel: the branch switch, then the commits of this import, with the no-change filter and ↑ / ↓ stepping as in today's timeline.
function CommitsPanel({ id, review }: { id: string; review: RepoReviewModel }) {
  const { commits, head, selectCommit, commitHref, branch } = review;
  const [hideUnchanged, setHideUnchanged] = useState(true);
  const list = useRef<HTMLOListElement>(null);
  const selectedRow = useRef<HTMLAnchorElement>(null);
  const { visible, hiddenCount } = useMemo(
    () => filterTimeline(commits, head, hideUnchanged),
    [commits, head, hideUnchanged],
  );
  const selectedIndex = visible.findIndex(({ sha }) => sha === head);

  // Keeps the selected row in view, and moves focus to it when focus was in the list.
  useEffect(() => {
    const row = selectedRow.current;
    if (!row) return;
    row.scrollIntoView?.({ block: "nearest" });
    if (list.current?.contains(document.activeElement)) row.focus({ preventScroll: true });
  }, [head, visible]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      const nextIndex = moveSelection(selectedIndex, event.key, visible.length);
      if (nextIndex === -1) return;
      event.preventDefault();
      if (nextIndex !== selectedIndex) selectCommit(visible[nextIndex].sha);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIndex, visible, selectCommit]);

  // A plain left click stays in the app; modified clicks keep the browser's own behaviour.
  function openCommit(event: ReactMouseEvent<HTMLAnchorElement>, sha: string) {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    selectCommit(sha);
  }

  return (
    <aside className="fb-flowview__commits" aria-labelledby="commits-title">
      <div className="fb-flowview__commits-head">
        <h2 id="commits-title">
          <Icon name="list" />
          Commits
        </h2>
        <span className="fb-flowview__count">{commits.length} {commits.length === 1 ? "commit" : "commits"}</span>
      </div>
      <div className="fb-flowview__commits-branch">
        <BranchSwitchScreen repoId={id} currentBranch={branch} />
      </div>
      {commits.length ? (
        <>
          <div className="fb-flowview__filter">
            <label>
              <input type="checkbox" checked={hideUnchanged} onChange={(event) => setHideUnchanged(event.target.checked)} />
              Hide commits with no flow change
            </label>
            <span aria-live="polite">{hiddenCount} hidden</span>
          </div>
          <ol className="fb-flowview__list" ref={list}>
            {visible.map((commit) => {
              const selected = commit.sha === head;
              return (
                <li key={commit.sha}>
                  <a
                    href={commitHref(commit.sha)}
                    ref={selected ? selectedRow : undefined}
                    className={cx("fb-flowview__row", selected && "fb-flowview__row--selected")}
                    aria-current={selected ? "true" : undefined}
                    tabIndex={selected ? 0 : -1}
                    onClick={(event) => openCommit(event, commit.sha)}
                  >
                    <code className="fb-flowview__sha" title={commit.sha}>{commit.sha.slice(0, 7)}</code>
                    <span className="fb-flowview__subject" title={commit.message}>{commit.message}</span>
                    <CommitBadges stats={commit.stats} />
                  </a>
                </li>
              );
            })}
          </ol>
          <p className="fb-flowview__keys"><kbd>↑</kbd> <kbd>↓</kbd> Navigate commits</p>
        </>
      ) : <p className="fb-flowview__empty">No commits available.</p>}
    </aside>
  );
}

// The +added / −removed / ~changed counts. A zero count is muted, so only the changes stand out.
function CommitBadges({ stats }: { stats: DiffStats }) {
  const counts = formatStats(stats);
  const values = { added: stats.nodes_added, removed: stats.nodes_removed, changed: stats.nodes_changed };
  return (
    <span className="fb-flowview__badges">
      {(["added", "removed", "changed"] as const).map((status) => (
        <span
          key={status}
          className={cx(
            "fb-flowview__badge",
            `fb-flowview__badge--${status}`,
            values[status] === 0 && "fb-flowview__badge--zero",
          )}
          title={`${counts[status].slice(1)} functions ${statusLabels[status].toLowerCase()}`}
        >
          {counts[status]}
        </span>
      ))}
    </span>
  );
}

// The centre's top part: the AI summary, the guide, the diagram and its toolbar. It is the element
// that goes full screen, as today's graph panel does.
function FlowArea({ review, onNodeClick }: { review: RepoReviewModel; onNodeClick: (node: OverlayNode) => void }) {
  const { fullscreen, diff, view, hasNodes, guideOpen, setGuide, flagsmithMode, flowChanged, hasCollapsedContext, contextExpanded, toggleContext } = review;
  const guideToggle = useRef<HTMLSpanElement>(null);

  return (
    <section
      ref={fullscreen.panel}
      className={cx("fb-flowview__flow", fullscreen.maximized && "fb-flowview__flow--maximized")}
      aria-label="Flow"
    >
      {diff && view === "overlay_summary" && diff.summary && <OverlaySummary summary={diff.summary} />}
      {hasNodes && guideOpen && (
        <FlowGuide
          onClose={() => {
            setGuide(false);
            guideToggle.current?.querySelector("button")?.focus();
          }}
        />
      )}
      <div className="fb-flowview__canvas">
        <Diagram review={review} onNodeClick={onNodeClick} />
      </div>
      {hasNodes && (
        <div className="fb-flowview__toolbar">
          <FlowLegend flagsmithMode={flagsmithMode} />
          <div className="fb-flowview__toolbar-actions">
            {diff && flowChanged && (hasCollapsedContext || contextExpanded) && (
              <Button variant="tertiary" size="sm" onClick={toggleContext}>
                {hasCollapsedContext ? "Expand all context" : "Collapse context"}
              </Button>
            )}
            <span ref={guideToggle}>
              <Button
                size="sm"
                aria-label="What am I looking at?"
                aria-expanded={guideOpen}
                aria-controls={guideOpen ? "diagram-guide" : undefined}
                title="What am I looking at?"
                onClick={() => setGuide(!guideOpen)}
              >
                ?
              </Button>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

// The diagram itself, or the state that replaces it: the same messages and order as today's RepoReview.
function Diagram({ review, onNodeClick }: { review: RepoReviewModel; onNodeClick: (node: OverlayNode) => void }) {
  const {
    hasNodes, subdir, request, layout, diff, currentLayout, flowChanged, view, direction, layoutPositions, fullscreen,
    selectedNode, selectedFlag, liveStates, expandModule, markRendered, nextChange, commitHref,
  } = review;

  if (!hasNodes) {
    return (
      <Notice>
        No Python code found in {subdir ? displaySubdir(subdir) : "this repository"}. code-flow analyzes Python only for now.
      </Notice>
    );
  }
  if (request.status === "loading") return <Notice role="status">Loading flow diff…</Notice>;
  if (request.status === "error") return <Notice role="alert">{request.message}</Notice>;
  if (!diff) return null;
  if (layout.status === "loading") return <Notice role="status">Laying out the flow…</Notice>;
  if (layout.status === "error") return <Notice role="alert">Could not lay out the flow. {layout.message}</Notice>;
  if (!currentLayout) return null;
  if (!flowChanged) {
    return <NoFlowChange next={nextChange && { href: commitHref(nextChange.sha), direction: nextChange.direction }} onReady={markRendered} />;
  }

  const View = view === "side_by_side" ? SideBySide : Overlay;
  return (
    <div className="fb-flowview__comparison">
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
        onNodeClick={onNodeClick}
        onExpandModule={expandModule}
        onReady={markRendered}
      />
    </div>
  );
}

function Notice({ role, children }: { role?: "status" | "alert"; children: ReactNode }) {
  return (
    <div className="fb-flowview__notice" role={role}>
      <div className="fb-flowview__card"><p>{children}</p></div>
    </div>
  );
}

function NoFlowChange({ next, onReady }: { next: { href: string; direction: string } | null; onReady: () => void }) {
  useEffect(onReady, [onReady]);

  return (
    <div className="fb-flowview__notice">
      <div className="fb-flowview__card">
        <Icon name="commit" size={24} />
        <h2>No flow change</h2>
        <p>This commit didn't change any Python functions or calls (it may touch tests, docs, migrations or other languages).</p>
        {next && (
          <Button to={next.href}>
            <Icon name="arrow-right" />
            Go to the {next.direction} commit with flow changes
          </Button>
        )}
      </div>
    </div>
  );
}

// The dismissable "What am I looking at?" strip, with the same copy as today's guide.
function FlowGuide({ onClose }: { onClose: () => void }) {
  const [more, setMore] = useState(false);

  return (
    <aside className="fb-flowview__guide" id="diagram-guide" aria-labelledby="diagram-guide-title">
      <div className="fb-flowview__guide-row">
        <Icon name="info" />
        <h3 id="diagram-guide-title">What am I looking at?</h3>
        <p>Boxes show Python symbols and arrows show calls. Click a symbol to read its code.</p>
        <div className="fb-flowview__guide-actions">
          <Button
            size="sm"
            variant="tertiary"
            aria-expanded={more}
            aria-controls="diagram-guide-details"
            onClick={() => setMore(!more)}
          >
            {more ? "Less" : "More"}
          </Button>
          <Button size="sm" variant="tertiary" onClick={onClose}>Dismiss</Button>
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

// The source dock: the tabs, then today's source pane (or the changed functions list).
function Dock({ id, review, tab, onTab, onSelectNode }: {
  id: string;
  review: RepoReviewModel;
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  onSelectNode: (node: OverlayNode) => void;
}) {
  const { head, diff, sourceOpen, setSourceOpen, sourceHeading, selectedNode, selectedCheck, clearSelection } = review;
  const nodes = diff?.nodes ?? [];

  return (
    <div className="fb-flowview__dock">
      {sourceOpen && (
        <Tabs
          label="Source or changed functions"
          active={tab}
          onChange={(next) => onTab(next as DockTab)}
          tabs={[
            { id: "source", label: "Source", icon: <Icon name="code" /> },
            { id: "functions", label: "Changed functions", icon: <Icon name="list" /> },
          ]}
        />
      )}
      {sourceOpen && tab === "functions" ? (
        <div className="fb-flowview__functions">
          <ChangedFunctions nodes={nodes} onSelect={onSelectNode} />
        </div>
      ) : (
        <CodePane
          repo={id}
          head={head}
          node={selectedNode}
          check={selectedCheck}
          headingRef={sourceHeading}
          nodes={nodes}
          open={sourceOpen}
          onSelect={onSelectNode}
          onClear={clearSelection}
          onOpenChange={setSourceOpen}
        />
      )}
    </div>
  );
}

// The right panel: the review question first and always visible, then the previews and This review.
function Inspector({ review, onOpenCheck }: { review: RepoReviewModel; onOpenCheck: (check: FlagCheck) => void }) {
  const {
    hasNodes, head, reviewContext, sendsReviewEvents, onReview, reviewKey, variantPreview, view, viewOverride,
    assignedView, flagsReady, direction, directionOverride, assignedDirection, longFlow, directionReady, viewSource,
    directionSource, flagsmithMode, liveFlagPanel, flags, findings, selectedFlag, selectFlag,
  } = review;

  return (
    <aside className="fb-flowview__inspector" aria-label="Review">
      {hasNodes && head && (
        <ReviewQuestion key={reviewKey} reviewContext={reviewContext} sendsReviewEvents={sendsReviewEvents} onReview={onReview} />
      )}
      {variantPreview && (
        <section className="fb-flowview__previews" aria-label="Preview controls">
          <VariantPreview
            view={view}
            viewOverride={viewOverride}
            assignedView={assignedView}
            ready={flagsReady}
            onChange={replaceViewOverride}
          />
          {hasNodes && head && (
            <DirectionPreview
              direction={direction}
              directionOverride={directionOverride}
              assignedDirection={assignedDirection}
              longFlow={longFlow}
              ready={directionReady}
              onChange={replaceDirectionOverride}
            />
          )}
        </section>
      )}
      <FlagsmithPanel
        view={{ value: flowViewLabels[view], source: viewSource }}
        direction={{ value: flowDirectionLabels[direction], source: directionSource }}
        enabled={flagsmithMode}
        showFindings={liveFlagPanel}
        data={flags}
        error={findings.status === "error" ? findings.message : undefined}
        loading={Boolean(head) && findings.status === "loading"}
        selected={selectedFlag?.name}
        onSelect={selectFlag}
        onOpenCheck={onOpenCheck}
      />
    </aside>
  );
}

// "Did this diagram help you understand the change?" The question, answers, keys and note are the
// same in every flow, and the answer goes through the same onReview as today's ReviewBar.
function ReviewQuestion({ reviewContext, sendsReviewEvents, onReview }: Pick<RepoReviewModel, "reviewContext" | "sendsReviewEvents" | "onReview">) {
  const { canReview, answered, submit } = useReviewQuestion(reviewContext, onReview);

  return (
    <section className="fb-flowview__review" aria-labelledby="review-question">
      <h2 id="review-question">Did this diagram help you understand the change?</h2>
      {answered ? (
        <p className="fb-flowview__thanks" role="status">
          <Icon name="check" />
          Thanks — recorded.
        </p>
      ) : (
        <div className="fb-flowview__answers">
          <Button
            variant="primary"
            className="fb-flowview__answer"
            aria-keyshortcuts="U"
            disabled={!canReview}
            onClick={() => submit("diff_understood")}
          >
            <Icon name="check" />
            Yes, I understand it <kbd>U</kbd>
          </Button>
          <Button
            className="fb-flowview__answer"
            aria-keyshortcuts="C"
            disabled={!canReview}
            onClick={() => submit("diff_confusing")}
          >
            <Icon name="close" />
            No, it's confusing <kbd>C</kbd>
          </Button>
        </div>
      )}
      <p className="fb-flowview__note">
        {sendsReviewEvents
          ? "Your answer feeds a Flagsmith A/B test of how code-flow shows diffs."
          : "Your answer stays local."}
      </p>
    </section>
  );
}

function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
