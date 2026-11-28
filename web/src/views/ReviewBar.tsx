import { useCallback, useEffect, useRef, useState } from "react";
import { buildReviewEvent, recordDiffViewed } from "../events";
import type { ReviewContext, ReviewEvent, ReviewOutcome } from "../events";

interface ReviewBarProps {
  context: ReviewContext | null;
  sendsReviewEvents: boolean;
  onReview: (payload: ReviewEvent) => void;
}

export function ReviewBar({ context, sendsReviewEvents, onReview }: ReviewBarProps) {
  const startedAt = useRef<number | null>(null);
  const recorded = useRef(false);
  const [started, setStarted] = useState(false);
  const [answered, setAnswered] = useState(false);
  const canReview = started && !answered && context !== null;

  useEffect(() => {
    if (!context || startedAt.current !== null) return;
    startedAt.current = performance.now();
    setStarted(true);
    recordDiffViewed(context);
  }, [context]);

  const submit = useCallback((event: ReviewOutcome) => {
    if (!context || startedAt.current === null || recorded.current) return;
    recorded.current = true;
    const payload = buildReviewEvent(context, event, startedAt.current, performance.now());
    setAnswered(true);
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
    <section className="review-bar" aria-labelledby="review-question">
      <div className="review-bar__prompt">
        <h3 id="review-question">Did this diagram help you understand the change?</h3>
        <p className="muted">
          {sendsReviewEvents
            ? "Your answer feeds a Flagsmith A/B test of how code-flow shows diffs."
            : "Your answer stays local."}
        </p>
      </div>
      <div className="review-bar__actions">
        {answered ? (
          <p role="status">Thanks — recorded.</p>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              aria-keyshortcuts="U"
              disabled={!canReview}
              onClick={() => submit("diff_understood")}
            >
              Yes, I understand it <kbd>U</kbd>
            </button>
            <button
              type="button"
              className="btn btn--sm"
              aria-keyshortcuts="C"
              disabled={!canReview}
              onClick={() => submit("diff_confusing")}
            >
              No, it's confusing <kbd>C</kbd>
            </button>
          </>
        )}
      </div>
    </section>
  );
}
