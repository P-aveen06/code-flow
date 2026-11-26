import { Overlay } from "./Overlay";
import type { DiffViewProps } from "./Overlay";

export function OverlaySummary(props: DiffViewProps) {
  const { summary } = props.diff;

  return (
    <>
      <div className="summary-bar">
        <span className="summary-bar__label">Summary</span>
        <p title={summary}>
          {summary.split(/(`[^`]+`)/).map((part, index) => (
            index % 2 === 1 ? <code key={index}>{part.slice(1, -1)}</code> : part
          ))}
        </p>
      </div>
      <Overlay {...props} />
    </>
  );
}
