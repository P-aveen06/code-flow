import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineCommit } from "../types";
import { statusLabels } from "./styles";
import { filterTimeline, formatCommitDate, formatStats, moveSelection } from "./timelineHelpers";

interface TimelineProps {
  commits: TimelineCommit[];
  selectedSha?: string;
  onSelect: (sha: string) => void;
}

export function Timeline({ commits, selectedSha, onSelect }: TimelineProps) {
  const [hideUnchanged, setHideUnchanged] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const { visible, hiddenCount } = useMemo(
    () => filterTimeline(commits, selectedSha, hideUnchanged),
    [commits, selectedSha, hideUnchanged],
  );
  const selectedIndex = visible.findIndex(({ sha }) => sha === selectedSha);

  useEffect(() => {
    const list = listRef.current;
    const row = selectedRef.current;
    if (!list || !row) return;
    const viewport = list.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    if (bounds.top < viewport.top) list.scrollTop += bounds.top - viewport.top;
    if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
  }, [selectedSha, visible]);

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
        list.querySelectorAll("button")[nextIndex]?.focus({ preventScroll: true });
      }
      onSelect(visible[nextIndex].sha);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIndex, visible, onSelect]);

  return (
    <aside className="sidebar timeline" aria-labelledby="timeline-title">
      <div className="panel-heading">
        <h2 id="timeline-title">Commit timeline</h2>
        <span className="muted">{commits.length} {commits.length === 1 ? "commit" : "commits"}</span>
      </div>
      {commits.length ? (
        <>
          <div className="timeline__filter">
            <label>
              <input type="checkbox" checked={hideUnchanged} onChange={(event) => setHideUnchanged(event.target.checked)} />
              Hide commits with no flow change
            </label>
            <p className="muted" aria-live="polite">{hiddenCount} hidden</p>
          </div>
          <ol className="timeline__list" ref={listRef}>
            {visible.map((commit, index) => {
              const selected = index === selectedIndex;
              const stats = formatStats(commit.stats);
              return (
                <li key={commit.sha}>
                  <button
                    type="button"
                    className="timeline__commit"
                    ref={selected ? selectedRef : undefined}
                    aria-current={selected ? "true" : undefined}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onSelect(commit.sha)}
                  >
                    <span className="timeline__meta">
                      <code title={commit.sha}>{commit.sha.slice(0, 7)}</code>
                      <time dateTime={commit.date}>{formatCommitDate(commit.date)}</time>
                    </span>
                    <span className="timeline__message">{commit.message}</span>
                    <span className="timeline__stats">
                      {(["added", "removed", "changed"] as const).map((status) => (
                        <span
                          key={status}
                          className={`timeline__badge timeline__badge--${status}`}
                          title={`${stats[status].slice(1)} functions ${statusLabels[status].toLowerCase()}`}
                          aria-label={`${stats[status].slice(1)} functions ${statusLabels[status].toLowerCase()}`}
                        >{stats[status]}</span>
                      ))}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="timeline__keys muted"><kbd>↑</kbd> <kbd>↓</kbd> Navigate commits</p>
        </>
      ) : <p className="panel-message">No commits available.</p>}
    </aside>
  );
}
