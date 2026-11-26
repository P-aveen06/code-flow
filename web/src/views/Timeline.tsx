import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { TimelineCommit } from "../types";
import { statusLabels } from "./styles";
import { formatStats, moveSelection } from "./timelineHelpers";

const commitDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

interface TimelineProps {
  commits: TimelineCommit[];
  selectedSha?: string;
  onSelect: (sha: string) => void;
}

export function Timeline({ commits, selectedSha, onSelect }: TimelineProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const selectedIndex = commits.findIndex(({ sha }) => sha === selectedSha);

  useEffect(() => {
    const list = listRef.current;
    const row = selectedRef.current;
    if (!list || !row) return;
    const viewport = list.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    if (bounds.top < viewport.top) list.scrollTop += bounds.top - viewport.top;
    if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
  }, [selectedSha]);

  function handleKeyDown(event: KeyboardEvent<HTMLOListElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const nextIndex = moveSelection(selectedIndex, event.key, commits.length);
    if (nextIndex === selectedIndex || nextIndex === -1) return;
    onSelect(commits[nextIndex].sha);
    event.currentTarget.querySelectorAll("button")[nextIndex]?.focus({ preventScroll: true });
  }

  return (
    <aside className="sidebar timeline" aria-labelledby="timeline-title">
      <div className="panel-heading">
        <h2 id="timeline-title">Commit timeline</h2>
        <span className="muted">{commits.length} {commits.length === 1 ? "commit" : "commits"}</span>
      </div>
      {commits.length ? (
        <>
          <ol className="timeline__list" ref={listRef} onKeyDown={handleKeyDown}>
            {commits.map((commit, index) => {
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
                      <time dateTime={commit.date}>{commitDate.format(new Date(commit.date))}</time>
                    </span>
                    <span className="timeline__message">{commit.message}</span>
                    <span className="timeline__stats">
                      {(["added", "removed", "changed"] as const).map((status) => (
                        <span
                          key={status}
                          className={`timeline__badge timeline__badge--${status}`}
                          aria-label={`${statusLabels[status]} ${stats[status].slice(1)}`}
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
