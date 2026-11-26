import { useEffect, useState } from "react";
import { fetchRepoFlags } from "./api";
import type { RepoFlags } from "./types";

type Result = { status: "ready"; data: RepoFlags } | { status: "error"; message: string };

export function useRepoFlags(repo: string, sha: string | undefined) {
  const [result, setResult] = useState<{ repo: string; sha: string; value: Result }>();

  useEffect(() => {
    if (!sha) {
      setResult(undefined);
      return;
    }
    const head = sha;
    const controller = new AbortController();
    let timer: number | undefined;

    async function refresh() {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]);
      let value: Result;
      try {
        const data = await fetchRepoFlags(repo, head, signal);
        value = { status: "ready", data };
      } catch (error) {
        const message = signal.aborted ? "Timed out loading Flagsmith findings."
          : error instanceof Error ? error.message : "Could not load Flagsmith findings.";
        value = { status: "error", message };
      }
      if (controller.signal.aborted) return;
      setResult({ repo, sha: head, value });
      timer = window.setTimeout(() => void refresh(), 10_000);
    }

    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [repo, sha]);

  return result?.repo === repo && result.sha === sha ? result.value : { status: "loading" } as const;
}
