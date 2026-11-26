import { useCallback, useEffect, useRef, useState } from "react";

type ShortcutKey = Pick<KeyboardEvent, "key" | "defaultPrevented" | "repeat" | "isComposing" | "altKey" | "ctrlKey" | "metaKey">;
const fullscreenTimeoutMs = 800;

export function isFullscreenShortcut(event: ShortcutKey, editing: boolean) {
  return event.key.toLowerCase() === "f" && !editing && !event.defaultPrevented && !event.repeat
    && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey;
}

export async function enterDiagramFullscreen(request?: () => Promise<void>) {
  if (!request) return "maximized";

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const native = request().then(() => "native" as const);
    const fallback = new Promise<"maximized">((resolve) => {
      timeout = setTimeout(() => resolve("maximized"), fullscreenTimeoutMs);
    });
    return await Promise.race([native, fallback]);
  } catch {
    // Embedded browsers can deny a request even when fullscreen is enabled.
    return "maximized";
  } finally {
    clearTimeout(timeout);
  }
}

export function useDiagramFullscreen(enabled: boolean) {
  const panel = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const [native, setNative] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const active = native || maximized;

  const toggle = useCallback(async () => {
    const area = panel.current;
    if (!area || pending.current) return;
    if (maximized) {
      setMaximized(false);
      return;
    }

    pending.current = true;
    try {
      if (document.fullscreenElement === area) {
        await document.exitFullscreen().catch(() => undefined);
      } else {
        const request = document.fullscreenEnabled && typeof area.requestFullscreen === "function"
          ? () => area.requestFullscreen() : undefined;
        const mode = await enterDiagramFullscreen(request);
        if (mode === "maximized" && panel.current === area && document.fullscreenElement !== area) {
          setMaximized(true);
        }
      }
    } finally {
      pending.current = false;
    }
  }, [maximized]);

  useEffect(() => {
    function syncFullscreen() {
      const isNative = panel.current !== null && document.fullscreenElement === panel.current;
      setNative(isNative);
      // If a timed-out request succeeds later, native fullscreen takes over.
      if (isNative) setMaximized(false);
    }
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    if (!enabled && !active) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (maximized && event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setMaximized(false);
        return;
      }
      const target = event.target;
      const editing = target instanceof HTMLElement
        && (target.isContentEditable || Boolean(target.closest("input, textarea, select")));
      if (!isFullscreenShortcut(event, editing)) return;
      event.preventDefault();
      void toggle();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, enabled, maximized, toggle]);

  return { panel, active, maximized, toggle };
}

export type DiagramFullscreen = ReturnType<typeof useDiagramFullscreen>;
