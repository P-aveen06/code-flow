import { useEffect, useRef, useState } from "react";
import { fetchAutoSync, updateAutoSync } from "../api";
import type { AutoSyncResponse } from "../types";

interface Toggle {
  repoId: string | null;
  checked: boolean;
}

export function useAutoSync(enabled: boolean) {
  const [saved, setSaved] = useState<AutoSyncResponse>();
  const [pending, setPending] = useState<Toggle>();
  const [loadError, setLoadError] = useState<string>();
  const [saveError, setSaveError] = useState<{ repoId: string | null; message: string }>();
  const mutation = useRef<AbortController | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: number;

    async function poll() {
      const startedAt = revision.current;
      try {
        if (mutation.current) return;
        const result = await fetchAutoSync(controller.signal);
        if (!controller.signal.aborted && startedAt === revision.current) {
          setSaved(result);
          setLoadError(undefined);
        }
      } catch (error) {
        if (!controller.signal.aborted && startedAt === revision.current) {
          setLoadError(error instanceof Error ? error.message : "Could not load auto-sync settings.");
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 3000);
      }
    }

    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [enabled]);

  useEffect(() => () => mutation.current?.abort(), []);

  async function change(repoId: string | null, checked: boolean) {
    if (!saved || mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    revision.current += 1;
    setPending({ repoId, checked });
    setSaveError(undefined);
    try {
      const result = await updateAutoSync(
        repoId === null ? { all: checked } : { repos: { [repoId]: checked } },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setSaved(result);
        setLoadError(undefined);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : "Try again.";
        setSaveError({ repoId, message: `Could not save auto-sync setting. ${detail}` });
      }
    } finally {
      if (!controller.signal.aborted) {
        mutation.current = null;
        setPending(undefined);
      }
    }
  }

  function checked(repoId: string | null) {
    if (pending?.repoId === repoId) return pending.checked;
    return (repoId === null ? saved?.all : saved?.repos[repoId]) ?? false;
  }

  return { saved, checked, change, loadError, saveError, disabled: !saved || Boolean(pending) };
}
