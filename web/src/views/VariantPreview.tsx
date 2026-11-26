import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { FLOW_VIEWS } from "../view";
import type { FlowView } from "../view";

const labels: Record<FlowView, string> = {
  side_by_side: "Side by side",
  overlay: "Overlay",
  overlay_summary: "Overlay + summary",
};

interface VariantPreviewProps {
  view: FlowView;
  viewOverride: string | null;
  assignedView: FlowView | null;
  ready: boolean;
  onChange: (view: FlowView | null) => void;
}

export function VariantPreview({ view, viewOverride, assignedView, ready, onChange }: VariantPreviewProps) {
  const group = useRef<HTMLDivElement>(null);
  const returningFocus = useRef(false);

  useEffect(() => {
    if (viewOverride === null && ready && returningFocus.current) {
      returningFocus.current = false;
      group.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    }
  }, [viewOverride, ready]);

  function selectByKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let direction: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp": direction = -1; break;
      case "ArrowRight":
      case "ArrowDown": direction = 1; break;
      default: return;
    }
    // Up and down already navigate commits outside the radio group.
    event.preventDefault();
    const next = (index + direction + FLOW_VIEWS.length) % FLOW_VIEWS.length;
    group.current?.querySelectorAll("button")[next]?.focus();
    onChange(FLOW_VIEWS[next]);
  }

  return (
    <>
      <div className="variant-preview__options">
        <span id="variant-preview-label">Preview variant</span>
        <div ref={group} className="segmented" role="radiogroup"
          aria-labelledby="variant-preview-label" aria-describedby="variant-preview-status">
          {FLOW_VIEWS.map((option, index) => (
            <button key={option} type="button" role="radio"
              className={ready && view === option ? "segmented__btn is-active" : "segmented__btn"}
              aria-checked={ready && view === option} tabIndex={view === option ? 0 : -1}
              onClick={() => onChange(option)} onKeyDown={(event) => selectByKey(event, index)}
            >
              {labels[option]}
            </button>
          ))}
        </div>
      </div>
      {viewOverride !== null ? (
        <div className="variant-preview__status">
          <span className="status-chip viewer-header__notice" id="variant-preview-status" role="status">
            Dev override: <code>view={viewOverride}</code> (not counted in the experiment)
          </span>
          <button type="button" className="btn btn--sm" onClick={() => {
            returningFocus.current = true;
            onChange(null);
          }}>Back to my assigned variant</button>
        </div>
      ) : (
        <p className="variant-preview__status muted" id="variant-preview-status" role="status">
          {!ready ? "Loading Flagsmith assignment…" : assignedView
            ? `Assigned by Flagsmith: ${labels[assignedView]}`
            : "Flagsmith unavailable — showing side by side"}
        </p>
      )}
    </>
  );
}
