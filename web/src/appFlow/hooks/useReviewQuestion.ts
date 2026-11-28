import { useCallback, useEffect, useRef, useState } from "react";
import { buildReviewEvent, recordDiffViewed } from "../../events";
import type { ReviewContext, ReviewEvent, ReviewOutcome } from "../../events";

// "Did this diagram help you understand the change?" The clock starts when the diagram is
// shown; the first answer (button, or U / C keys) is recorded once and then locks the question.
export function useReviewQuestion(context: ReviewContext | null, onReview: (payload: ReviewEvent) => void) {
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

  const submit = useCallback((outcome: ReviewOutcome) => {
    if (!context || startedAt.current === null || recorded.current) return;
    recorded.current = true;
    const payload = buildReviewEvent(context, outcome, startedAt.current, performance.now());
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

  return { canReview, answered, submit };
}
