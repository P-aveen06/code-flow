import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { FLOW_DIRECTIONS, FLOW_VIEWS } from "../view";
import type { FlowDirection, FlowView } from "../view";

export const flowViewLabels: Record<FlowView, string> = {
  side_by_side: "Side by side",
  overlay: "Overlay",
  overlay_summary: "Overlay + summary",
};

export const flowDirectionLabels: Record<FlowDirection, string> = {
  horizontal: "Horizontal",
  vertical: "Vertical",
};

interface VariantPreviewProps {
  view: FlowView;
  viewOverride: string | null;
  assignedView: FlowView | null;
  ready: boolean;
  onChange: (view: FlowView | null) => void;
}

export function VariantPreview({ view, viewOverride, assignedView, ready, onChange }: VariantPreviewProps) {
  return (
    <Preview
      name="variant" param="view" options={FLOW_VIEWS} labels={flowViewLabels}
      selected={view} override={viewOverride} ready={ready} onChange={onChange}
      status={!ready ? "Loading Flagsmith assignment…" : assignedView
        ? `Assigned by Flagsmith: ${flowViewLabels[assignedView]}`
        : "Flagsmith unavailable — showing side by side"}
    />
  );
}

export function DirectionPreview({ direction, directionOverride, assignedDirection, longFlow, ready, onChange }: {
  direction: FlowDirection;
  directionOverride: string | null;
  assignedDirection: FlowDirection | null;
  longFlow: boolean | undefined;
  ready: boolean;
  onChange: (direction: FlowDirection | null) => void;
}) {
  const status = longFlow === false ? "Short flow: horizontal (not in the experiment)"
    : !ready ? "Waiting for flow direction…"
    : assignedDirection ? `Assigned by Flagsmith: ${flowDirectionLabels[assignedDirection]}`
    : "Flagsmith has no direction assignment — showing horizontal";
  return (
    <Preview
      name="direction" param="direction" options={FLOW_DIRECTIONS} labels={flowDirectionLabels}
      selected={direction} override={directionOverride} ready={ready} onChange={onChange} status={status}
    />
  );
}

function Preview<Option extends string>({
  name, param, options, labels, selected, override, ready, onChange, status,
}: {
  name: "variant" | "direction";
  param: "view" | "direction";
  options: readonly Option[];
  labels: Record<Option, string>;
  selected: Option;
  override: string | null;
  ready: boolean;
  onChange: (option: Option | null) => void;
  status: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const returningFocus = useRef(false);
  const labelId = `${name}-preview-label`;
  const statusId = `${name}-preview-status`;

  useEffect(() => {
    if (override === null && ready && returningFocus.current) {
      returningFocus.current = false;
      group.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    }
  }, [override, ready]);

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
    const next = (index + direction + options.length) % options.length;
    group.current?.querySelectorAll("button")[next]?.focus();
    onChange(options[next]);
  }

  return (
    <div className="variant-preview">
      <div className="variant-preview__options">
        <span className="variant-preview__label" id={labelId}>Preview {name}</span>
        <div ref={group} className="segmented" role="radiogroup"
          aria-labelledby={labelId} aria-describedby={statusId}>
          {options.map((option, index) => (
            <button key={option} type="button" role="radio"
              className={ready && selected === option ? "segmented__btn is-active" : "segmented__btn"}
              aria-checked={ready && selected === option} tabIndex={selected === option ? 0 : -1}
              onClick={() => onChange(option)} onKeyDown={(event) => selectByKey(event, index)}
            >
              {labels[option]}
            </button>
          ))}
        </div>
      </div>
      {override !== null ? (
        <div className="variant-preview__status">
          <span className="status-chip viewer-header__notice" id={statusId} role="status">
            Dev override: <code>{`${param}=${override}`}</code> (not counted in the experiment)
          </span>
          <button type="button" className="btn btn--sm" onClick={() => {
            returningFocus.current = true;
            onChange(null);
          }}>Back to my assigned {name}</button>
        </div>
      ) : (
        <p className="variant-preview__status muted" id={statusId} role="status">
          {status}
        </p>
      )}
    </div>
  );
}
