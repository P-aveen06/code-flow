import { useReviewQuestion } from "../appFlow/hooks/useReviewQuestion";
import type { ReviewContext, ReviewEvent } from "../events";

interface ReviewBarProps {
  context: ReviewContext | null;
  sendsReviewEvents: boolean;
  onReview: (payload: ReviewEvent) => void;
}

export function ReviewBar({ context, sendsReviewEvents, onReview }: ReviewBarProps) {
  const { canReview, answered, submit } = useReviewQuestion(context, onReview);

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
