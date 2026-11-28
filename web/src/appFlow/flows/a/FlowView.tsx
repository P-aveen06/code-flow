// Flow A "Guided" flow view: a story column (this commit, its counts, the review question, the
// commit steps and Flagsmith) beside one large diagram. The data and the behaviour come from
// useReviewData and useRepoReview, as in today's Viewer. This file lays them out and adds no fetches.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import type { ReviewContext, ReviewEvent } from "../../../events";
import { displaySubdir } from "../../../pages/importHelpers";
import { navigate } from "../../../router";
import type { TimelineCommit } from "../../../types";
import { replaceDirectionOverride, replaceViewOverride } from "../../../view";
import { CodePane } from "../../../views/CodePane";
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
import { Avatar, Chip, Header, Icon } from "./kit";
import "./flowview.css";

const neighboursHint = "How many callers/callees around the changed functions to show";

// "fix(scope): message" shows its prefix on a line of its own, and the message starts with a capital.
function splitCommitTitle(message: string) {
  const separator = message.indexOf(": ");
  const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  if (separator < 0) return { prefix: "", title: capitalise(message) };
  return { prefix: message.slice(0, separator + 1), title: capitalise(message.slice(separator + 2)) };
}

function isPlainClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function focusFirstButton(container: HTMLElement | null) {
  container?.querySelector<HTMLButtonElement>("button")?.focus();
}

export function FlowViewA({ id, search }: { id: string; search: string }) {
  const review = useReviewData(id);
  if (review.status === "ready") return <FlowReview id={id} search={search} initial={review.data} />;
  return (
    <FlowShell className="fa-flowview__body--message">
      <p className="fa-flowview__state" role={review.status === "loading" ? "status" : "alert"}>
        {review.status === "loading" ? "Loading commit history…" : review.message}
      </p>
    </FlowShell>
  );
}

// The page frame: the kit's header, then the body. The body is a grid of story and diagram.
function FlowShell({ right, className, children }: { right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className="fa-flowview">
      <Header right={right} />
      <main className={className ? `fa-flowview__body ${className}` : "fa-flowview__body"}>{children}</main>
    </div>
  );
}

function FlowReview({ id, search, initial }: { id: string; search: string; initial: ReviewData }) {
  const review = useRepoReview(id, search, initial);
  const { me, signOut: endSession } = useMe();
  const {
    name, subdir, url, branch, hasNodes, commits, selected, head, commitTitle, selectCommit, commitHref, nextChange,
    refresh, checkForNewCommits, flowChanged, view, viewOverride, assignedView, viewSource, direction,
    directionOverride, assignedDirection, directionSource, directionReady, longFlow, flagsReady, variantPreview,
    hops, setHops, diff, request, layout, currentLayout, hasCollapsedContext, contextExpanded, toggleContext,
    expandModule, layoutPositions, fullscreen, markRendered, guideOpen, setGuide, reviewContext, sendsReviewEvents,
    onReview, reviewKey, selectedNode, selectNode, selectedCheck, openCheck, clearSelection, sourceOpen, setSourceOpen,
    findings, flags, flagsmithMode, liveFlagPanel, liveStates, selectedFlag, selectFlag,
  } = review;
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [hideUnchanged, setHideUnchanged] = useState(true);
  // The drawer opens with a selected function or check, or when the visitor asks for it. The shared
  // preference alone would open it on every page, which the design does not do.
  const [sourceRequested, setSourceRequested] = useState(false);
  const drawerOpen = sourceOpen && (sourceRequested || Boolean(selectedNode || selectedCheck));
  function clearDrawerSelection() {
    setSourceRequested(true);
    clearSelection();
  }
  const commitList = useRef<HTMLOListElement>(null);
  const guideWrap = useRef<HTMLDivElement>(null);
  const commitsWrap = useRef<HTMLDivElement>(null);
  const guideId = useId();

  const { visible, hiddenCount } = useMemo(
    () => filterTimeline(commits, head, hideUnchanged),
    [commits, head, hideUnchanged],
  );
  // The list shows the newest commit first, so ↑ and "Newer" move up it.
  const rows = useMemo(() => [...visible].reverse(), [visible]);
  const index = rows.findIndex(({ sha }) => sha === head);
  const newer = index > 0 ? rows[index - 1] : undefined;
  const older = index >= 0 && index < rows.length - 1 ? rows[index + 1] : undefined;

  // ↑ and ↓ step through the commits from anywhere on the page, as the commit list did.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;

      const next = moveSelection(index, event.key, rows.length);
      if (next === -1) return;
      event.preventDefault();
      if (next === index) return;
      const list = commitList.current;
      if (list?.contains(document.activeElement)) list.querySelectorAll("a")[next]?.focus({ preventScroll: true });
      selectCommit(rows[next].sha);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [index, rows, selectCommit]);

  const withFlowChange = commits.filter(({ stats }) => hasFlowChange(stats)).length;
  const subdirLabel = subdir ? displaySubdir(subdir) : null;
  const account = me.status === "ready" && me.data.signed_in ? me.data : null;
  const isGitHub = url?.startsWith("https://github.com/") ?? false;
  const View = view === "side_by_side" ? SideBySide : Overlay;
  const title = splitCommitTitle(commitTitle);

  // Ends the session, then goes to the start page, as the repos page does.
  function signOut() {
    void endSession().finally(() => navigate("/"));
  }

  const right = account ? (
    <>
      <span className="fa-flowview__account">
        <Avatar login={account.login} src={account.avatar_url} />
        <span>@{account.login}</span>
      </span>
      <Button variant="tertiary" size="sm" onClick={signOut}>
        Sign out <Icon name="arrow-right" size={14} />
      </Button>
    </>
  ) : undefined;

  return (
    <FlowShell right={right}>
      <div className="fa-flowview__story">
        <div className="fa-flowview__crumbs">
          {/* An imported branch is named repo@branch; its branch is shown in the switch beside it. */}
          <span className="fa-flowview__repo">{name.replace(/@.*$/, "")}</span>
          <span aria-hidden="true">/</span>
          <BranchSwitchScreen repoId={id} currentBranch={branch} />
        </div>

        {selected && (
          <div className="fa-flowview__commit">
            {title.prefix && <p className="fa-flowview__prefix">{title.prefix}</p>}
            <h1 title={commitTitle}>{title.title}</h1>
            <p className="fa-flowview__meta">
              {selected.author && <span>{selected.author}</span>}
              <time dateTime={selected.date}>{formatCommitDate(selected.date)}</time>
              <code title={selected.sha}>{selected.sha.slice(0, 7)}</code>
            </p>
            {subdirLabel && <p className="fa-flowview__subdir">Subfolder <code>{subdirLabel}</code></p>}
          </div>
        )}

        {selected && (
          <dl className="fa-flowview__counts" title={formatFunctionCounts(selected.stats)}>
            {([
              ["Added", selected.stats.nodes_added],
              ["Removed", selected.stats.nodes_removed],
              ["Changed", selected.stats.nodes_changed],
            ] as const).map(([label, count]) => (
              <div className="fa-flowview__count" key={label}>
                <dt>{label}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
        )}

        {flowChanged && diff && currentLayout && view === "overlay_summary" && (
          <div className="fa-flowview__summary">
            <OverlaySummary summary={diff.summary} />
          </div>
        )}

        {hasNodes && head && (
          <ReviewQuestion
            key={reviewKey} context={reviewContext} sendsReviewEvents={sendsReviewEvents} onReview={onReview}
          />
        )}

        <div className="fa-flowview__steps">
          <Button size="sm" disabled={!newer} onClick={() => { if (newer) selectCommit(newer.sha); }}>
            <Icon name="arrow-up" size={14} />Newer
          </Button>
          <Button size="sm" disabled={!older} onClick={() => { if (older) selectCommit(older.sha); }}>
            <Icon name="arrow-down" size={14} />Older
          </Button>
        </div>
        <div className="fa-flowview__all" ref={commitsWrap}>
          <Button size="sm" aria-expanded={commitsOpen} onClick={() => setCommitsOpen(true)}>
            <Icon name="layers" size={14} />All commits ({withFlowChange} with flow changes)
          </Button>
        </div>

        <details className="fa-flowview__flagsmith">
          <summary>
            <Icon name="flag" size={14} />Flagsmith: {flowViewLabels[view]} · {flowDirectionLabels[direction]}
          </summary>
          <div className="fa-flowview__flagsmith-body">
            {variantPreview && (
              <VariantPreview
                view={view} viewOverride={viewOverride} assignedView={assignedView} ready={flagsReady}
                onChange={replaceViewOverride}
              />
            )}
            {variantPreview && hasNodes && head && (
              <DirectionPreview
                direction={direction} directionOverride={directionOverride} assignedDirection={assignedDirection}
                longFlow={longFlow} ready={directionReady} onChange={replaceDirectionOverride}
              />
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
              onOpenCheck={openCheck}
            />
          </div>
        </details>
      </div>

      <section
        className={fullscreen.maximized ? "fa-flowview__canvas fa-flowview__canvas--maximized" : "fa-flowview__canvas"}
        aria-labelledby="fa-flowview-flow" ref={fullscreen.panel}
      >
        <header className="fa-flowview__toolbar">
          <div className="fa-flowview__title">
            <h2 id="fa-flowview-flow">Commit flow</h2>
            {diff && (
              <code title={`${diff.base || "Empty graph"} → ${diff.head}`}>
                {flowChanged
                  ? `${diff.base ? diff.base.slice(0, 7) : "Empty graph"} → ${diff.head.slice(0, 7)}`
                  : diff.head.slice(0, 7)}
              </code>
            )}
          </div>
          <div className="fa-flowview__tools">
            {hasNodes && (
              <div className="fa-flowview__neighbours" role="group" aria-labelledby="fa-flowview-neighbours" title={neighboursHint}>
                <span id="fa-flowview-neighbours">Show neighbours</span>
                <div className="fa-flowview__segment">
                  {([1, 2] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={hops === option ? "is-active" : undefined}
                      aria-pressed={hops === option}
                      onClick={() => setHops(option)}
                    >
                      {option} {option === 1 ? "step" : "steps"}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {diff && flowChanged && (hasCollapsedContext || contextExpanded) && (
              <Button size="sm" onClick={toggleContext}>
                {hasCollapsedContext ? "Expand all context" : "Collapse context"}
              </Button>
            )}
            {isGitHub && (
              <div className="fa-flowview__refresh">
                <Button size="sm" disabled={refresh?.status === "running"} onClick={checkForNewCommits}>
                  <Icon name="refresh" size={14} />Check for new commits
                </Button>
                {refresh && <span role={refresh.status === "error" ? "alert" : "status"}>{refresh.text}</span>}
              </div>
            )}
            {hasNodes && flowChanged && (
              <div className="fa-flowview__guide-toggle" ref={guideWrap}>
                <Button
                  size="sm" aria-label="What am I looking at?" title="What am I looking at?" aria-expanded={guideOpen}
                  aria-controls={guideOpen ? guideId : undefined} onClick={() => setGuide(!guideOpen)}
                >
                  <Icon name="info" size={14} />
                </Button>
              </div>
            )}
            {flowChanged && (
              <Button
                size="sm" aria-expanded={drawerOpen} aria-controls="fa-flowview-source"
                onClick={() => { setSourceRequested(true); setSourceOpen(!drawerOpen); }}
              >
                <Icon name="code" size={14} />Source code
              </Button>
            )}
          </div>
        </header>

        <div className="fa-flowview__stage">
          {hasNodes && flowChanged && guideOpen && (
            <Guide
              id={guideId}
              onDismiss={() => {
                setGuide(false);
                focusFirstButton(guideWrap.current);
              }}
            />
          )}
          {!hasNodes && (
            <p className="fa-flowview__state">
              No Python code found in {subdirLabel ?? "this repository"}. code-flow analyzes Python only for now.
            </p>
          )}
          {hasNodes && request.status === "loading" && <p className="fa-flowview__state" role="status">Loading flow diff…</p>}
          {request.status === "error" && <p className="fa-flowview__state" role="alert">{request.message}</p>}
          {diff && layout.status === "loading" && <p className="fa-flowview__state" role="status">Laying out the flow…</p>}
          {diff && layout.status === "error" && (
            <p className="fa-flowview__state" role="alert">Could not lay out the flow. {layout.message}</p>
          )}
          {diff && currentLayout && (flowChanged ? (
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
              <div className="fa-flowview__legend">
                <FlowLegend flagsmithMode={flagsmithMode} />
              </div>
            </>
          ) : (
            <NoFlowChange
              next={nextChange && { href: commitHref(nextChange.sha), direction: nextChange.direction }}
              onReady={markRendered}
            />
          ))}
        </div>

        <div className="fa-flowview__drawer" id="fa-flowview-source" hidden={!drawerOpen}>
          <CodePane
            repo={id} head={head} node={selectedNode} check={selectedCheck} nodes={diff?.nodes ?? []}
            open={drawerOpen} onSelect={selectNode} onClear={clearDrawerSelection} onOpenChange={setSourceOpen}
          />
        </div>
      </section>

      {commitsOpen && (
        <CommitDrawer
          rows={rows}
          total={commits.length}
          hiddenCount={hiddenCount}
          hideUnchanged={hideUnchanged}
          onHideUnchangedChange={setHideUnchanged}
          head={head}
          commitHref={commitHref}
          onSelect={selectCommit}
          listRef={commitList}
          onClose={() => {
            setCommitsOpen(false);
            focusFirstButton(commitsWrap.current);
          }}
        />
      )}
    </FlowShell>
  );
}

// "Did this diagram help you understand the change?" The question, answers, U / C keys and the
// onReview call are the same as ReviewBar's; only the markup is this flow's.
function ReviewQuestion({ context, sendsReviewEvents, onReview }: {
  context: ReviewContext | null;
  sendsReviewEvents: boolean;
  onReview: (payload: ReviewEvent) => void;
}) {
  const { canReview, answered, submit } = useReviewQuestion(context, onReview);
  const titleId = useId();

  return (
    <section className="fa-flowview__question" aria-labelledby={titleId}>
      <h3 id={titleId}>Did this diagram help you understand the change?</h3>
      {answered ? (
        <p className="fa-flowview__thanks" role="status">
          <Icon name="check" size={16} />Thanks — recorded.
        </p>
      ) : (
        <div className="fa-flowview__answers">
          <Button variant="primary" size="sm" aria-keyshortcuts="U" disabled={!canReview} onClick={() => submit("diff_understood")}>
            Yes, I understand it <kbd>U</kbd>
          </Button>
          <Button size="sm" aria-keyshortcuts="C" disabled={!canReview} onClick={() => submit("diff_confusing")}>
            No, it's confusing <kbd>C</kbd>
          </Button>
        </div>
      )}
      <p className="fa-flowview__note">
        {sendsReviewEvents
          ? "Your answer feeds a Flagsmith A/B test of how code-flow shows diffs."
          : "Your answer stays local."}
      </p>
    </section>
  );
}

function NoFlowChange({ next, onReady }: {
  next: { href: string; direction: string } | null;
  onReady: () => void;
}) {
  useEffect(() => {
    onReady();
  }, [onReady]);

  return (
    <div className="fa-flowview__empty">
      <span className="fa-flowview__empty-icon" aria-hidden="true"><Icon name="code" size={24} /></span>
      <h3>No flow change in this commit</h3>
      <p>This commit didn't change any Python functions or calls (it may touch tests, docs, migrations or other languages).</p>
      {next && (
        <Button to={next.href}>
          Go to the {next.direction} commit with flow changes <Icon name="arrow-right" size={16} />
        </Button>
      )}
    </div>
  );
}

// "What am I looking at?" The copy is today's guide.
function Guide({ id, onDismiss }: { id: string; onDismiss: () => void }) {
  const [more, setMore] = useState(false);
  const titleId = useId();
  const detailsId = useId();

  return (
    <aside className="fa-flowview__guide" id={id} aria-labelledby={titleId}>
      <div className="fa-flowview__guide-head">
        <Icon name="info" size={16} />
        <h3 id={titleId}>What am I looking at?</h3>
        <Button variant="tertiary" size="sm" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="close" size={14} />
        </Button>
      </div>
      <p>Boxes show Python symbols and arrows show calls. Click a symbol to read its code.</p>
      <div>
        <Button
          variant="tertiary" size="sm" className="fa-flowview__disclose" aria-expanded={more}
          aria-controls={detailsId} onClick={() => setMore(!more)}
        >
          <Icon name="chevron-right" size={14} />{more ? "Less" : "More"}
        </Button>
      </div>
      <ul id={detailsId} className="fa-flowview__guide-more" hidden={!more}>
        <li>Symbols are grouped by module. Click a context chip to expand its module.</li>
        <li>A → B means A calls B. A label like <code>fast_path: on</code> shows when that call runs.</li>
        <li>Use <kbd>↑</kbd> and <kbd>↓</kbd> to step through commits.</li>
      </ul>
    </aside>
  );
}

function CommitDrawer({
  rows, total, hiddenCount, hideUnchanged, onHideUnchangedChange, head, commitHref, onSelect, listRef, onClose,
}: {
  rows: TimelineCommit[];
  total: number;
  hiddenCount: number;
  hideUnchanged: boolean;
  onHideUnchangedChange(hide: boolean): void;
  head: string | undefined;
  commitHref(sha: string): string;
  onSelect(sha: string): void;
  listRef: RefObject<HTMLOListElement | null>;
  onClose(): void;
}) {
  const titleId = useId();

  // Keeps the selected commit in view, as the commit list did.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !row) return;
    const viewport = list.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    if (bounds.top < viewport.top) list.scrollTop += bounds.top - viewport.top;
    if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
  }, [head, rows, listRef]);

  return (
    <aside className="fa-flowview__commits" aria-labelledby={titleId}>
      <div className="fa-flowview__commits-head">
        <h2 id={titleId}>Commits</h2>
        <span className="fa-flowview__muted">{total} {total === 1 ? "commit" : "commits"}</span>
        <Button variant="tertiary" size="sm" aria-label="Close commits" onClick={onClose}>
          <Icon name="close" size={14} />
        </Button>
      </div>
      <div className="fa-flowview__filter">
        <label>
          <input
            type="checkbox" checked={hideUnchanged}
            onChange={(event) => onHideUnchangedChange(event.target.checked)}
          />
          Hide commits with no flow change
        </label>
        <p aria-live="polite">{hiddenCount} hidden</p>
      </div>
      {rows.length ? (
        <ol className="fa-flowview__list" ref={listRef}>
          {rows.map((commit) => {
            const current = commit.sha === head;
            const stats = formatStats(commit.stats);
            return (
              <li key={commit.sha}>
                <a
                  className="fa-flowview__row"
                  href={commitHref(commit.sha)}
                  aria-current={current ? "true" : undefined}
                  onClick={(event) => {
                    if (!isPlainClick(event)) return;
                    event.preventDefault();
                    onSelect(commit.sha);
                  }}
                >
                  <span className="fa-flowview__row-meta">
                    <code title={commit.sha}>{commit.sha.slice(0, 7)}</code>
                    {commit.author && <span>{commit.author}</span>}
                    <time dateTime={commit.date}>{formatCommitDate(commit.date, true)}</time>
                  </span>
                  <span className="fa-flowview__row-message">{commit.message}</span>
                  <span className="fa-flowview__row-stats" title={formatFunctionCounts(commit.stats)}>
                    <Chip tone="added">{stats.added}</Chip>
                    <Chip tone="removed">{stats.removed}</Chip>
                    <Chip tone="changed">{stats.changed}</Chip>
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      ) : <p className="fa-flowview__state">No commits available.</p>}
      <p className="fa-flowview__keys"><kbd>↑</kbd> <kbd>↓</kbd> Navigate commits</p>
    </aside>
  );
}
