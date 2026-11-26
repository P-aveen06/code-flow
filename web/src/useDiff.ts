import { useCallback } from "react";
import { fetchDiff } from "./api";
import { layoutFlow } from "./layout/elk";
import { useRequest } from "./useRequest";

export type Hops = 1 | 2;

export function useDiff(repo: string, head: string | undefined, hops: Hops) {
  const loadDiff = useCallback(
    (signal: AbortSignal) => head ? fetchDiff(repo, head, { hops }, signal) : Promise.resolve(null),
    [repo, head, hops],
  );
  const request = useRequest(loadDiff);
  const diff = request.status === "ready" ? request.data : null;
  const loadLayout = useCallback(
    () => diff ? layoutFlow(diff.nodes, diff.edges) : Promise.resolve(null),
    [diff],
  );
  const layout = useRequest(loadLayout);

  return { request, diff, layout };
}
