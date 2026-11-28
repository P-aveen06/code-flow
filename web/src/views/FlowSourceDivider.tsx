import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import {
  clampSourcePercent, defaultSourcePercent, parseSourcePercent, sourcePercentBounds, sourcePercentForKey,
} from "./flowSourceSplit";

const sourceSplitPreference = "code-flow:source-split";

function readSourcePercent() {
  try {
    return parseSourcePercent(window.localStorage.getItem(sourceSplitPreference));
  } catch {
    return defaultSourcePercent;
  }
}

function saveSourcePercent(percent: number) {
  try {
    window.localStorage.setItem(sourceSplitPreference, String(percent));
  } catch {
    // The divider still works when storage is blocked.
  }
}

interface FlowSourceDividerProps {
  workspace: RefObject<HTMLDivElement | null>;
  sourceHeading: RefObject<HTMLDivElement | null>;
  hidden: boolean;
}

export function FlowSourceDivider({ workspace, sourceHeading, hidden }: FlowSourceDividerProps) {
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startPercent: number; lastPercent?: number }>(null);
  const [preferredPercent, setPreferredPercent] = useState(readSourcePercent);
  const [size, setSize] = useState<{ paneHeight: number; headingHeight: number }>();
  const bounds = size ? sourcePercentBounds(size.paneHeight, size.headingHeight) : { min: 0, max: 100 };
  const percent = clampSourcePercent(preferredPercent, bounds);

  useEffect(() => {
    const area = workspace.current;
    const heading = sourceHeading.current;
    const handle = divider.current;
    if (!area || !heading || !handle) return;

    const measure = () => {
      const dividerHeight = handle.offsetHeight;
      const paneHeight = area.clientHeight - dividerHeight;
      const headingHeight = heading.offsetHeight;
      if (dividerHeight === 0 || paneHeight <= 0) return;
      setSize((previous) => previous?.paneHeight === paneHeight && previous.headingHeight === headingHeight
        ? previous : { paneHeight, headingHeight });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    observer.observe(heading);
    observer.observe(handle);
    return () => observer.disconnect();
  }, [workspace, sourceHeading]);

  useLayoutEffect(() => {
    if (size) workspace.current?.style.setProperty("--source-height", `${size.paneHeight * percent / 100}px`);
  }, [workspace, size, percent]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current || !size) return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startPercent: percent };
  }

  function moveDivider(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId || !size) return;
    const delta = (active.startY - event.clientY) / size.paneHeight * 100;
    active.lastPercent = clampSourcePercent(active.startPercent + delta, bounds);
    setPreferredPercent(active.lastPercent);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    if (active.lastPercent !== undefined) saveSourcePercent(active.lastPercent);
  }

  function applyPercent(next: number) {
    setPreferredPercent(next);
    saveSourcePercent(next);
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    const next = sourcePercentForKey(event.key, percent);
    if (next === undefined) return;
    event.preventDefault();
    applyPercent(event.key === "Home" ? next : clampSourcePercent(next, bounds));
  }

  return (
    <div ref={divider} className="workspace__divider" hidden={hidden} tabIndex={0} role="separator"
      aria-label="Resize flow and source code" aria-orientation="horizontal" aria-controls="source-code"
      aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(percent)}
      aria-valuetext={`${Math.round(percent)}% source code`}
      onPointerDown={startDrag} onPointerMove={moveDivider} onPointerUp={endDrag}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onDoubleClick={() => applyPercent(defaultSourcePercent)} onKeyDown={handleKey}
    />
  );
}
