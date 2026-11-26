import { useCallback, useEffect, useRef, useState } from "react";
import { buildReviewEvent, formatElapsed, recordDiffViewed } from "../events";
import type { ReviewContext, ReviewEvent, ReviewOutcome } from "../events";

interface ReviewBarProps {
  context: ReviewContext | null;
  onReview: (payload: ReviewEvent) => void;
}

export function ReviewBar({ context, onReview }: ReviewBarProps) {
  const startedAt = useRef<number | null>(null);
  const recorded = useRef(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [recordedMs, setRecordedMs] = useState<number | null>(null);
  const started = elapsed !== null;
  const canReview = started && recordedMs === null && context !== null;

  useEffect(() => {
    if (!context || startedAt.current !== null) return;
    startedAt.current = performance.now();
    setElapsed(0);
    recordDiffViewed(context);
  }, [context]);

  useEffect(() => {
    if (!started || recordedMs !== null) return;
    const timer = window.setInterval(() => {
      if (startedAt.current !== null) setElapsed(performance.now() - startedAt.current);
    }, 100);
    return () => window.clearInterval(timer);
  }, [started, recordedMs]);

  const submit = useCallback((event: ReviewOutcome) => {
    if (!context || startedAt.current === null || recorded.current) return;
    recorded.current = true;
    const payload = buildReviewEvent(context, event, startedAt.current, performance.now());
    setRecordedMs(payload.ms);
    onReview(payload);
  }, [context, onReview]);

  useEffect(() => {
    if (!canReview) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;

      switch (event.key.toLowerCase()) {
        case "u": submit("diff_understood"); break;
        case "c": submit("diff_confusing"); break;
        default: return;
      }
      event.preventDefault();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canReview, submit]);

  return (
    <div className="review-bar">
      <button
        type="button"
        className="btn btn--primary"
        aria-keyshortcuts="U"
        disabled={!canReview}
        onClick={() => submit("diff_understood")}
      >
        Understood / Approve <kbd>U</kbd>
      </button>
      <button
        type="button"
        className="btn"
        aria-keyshortcuts="C"
        disabled={!canReview}
        onClick={() => submit("diff_confusing")}
      >
        Confusing <kbd>C</kbd>
      </button>
      {recordedMs === null && (
        <span className="muted review-bar__timer" role="timer" aria-label="Review time">
          {elapsed === null ? "—" : formatElapsed(elapsed)}
        </span>
      )}
      <span className="muted" role="status">
        {recordedMs !== null && `Recorded after ${formatElapsed(recordedMs)}`}
      </span>
    </div>
  );
}
