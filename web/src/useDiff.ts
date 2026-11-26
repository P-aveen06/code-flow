import { useCallback, useMemo } from "react";
import { fetchDiff } from "./api";
import { layoutFlow } from "./layout/elk";
import { useRequest } from "./useRequest";
import { collapseContext } from "./views/collapse";
import type { ExpandedContext } from "./views/collapse";

export type Hops = 1 | 2;

export function useDiff(
  repo: string, head: string | undefined, hops: Hops, expanded: ExpandedContext, comparison: boolean,
) {
  const loadDiff = useCallback(
    (signal: AbortSignal) => head ? fetchDiff(repo, head, { hops }, signal) : Promise.resolve(null),
    [repo, head, hops],
  );
  const request = useRequest(loadDiff);
  const diff = request.status === "ready" ? request.data : null;
  const graph = useMemo(
    () => diff ? collapseContext(diff.nodes, diff.edges, expanded) : null,
    [diff, expanded],
  );
  const loadLayout = useCallback(
    () => graph ? layoutFlow(graph.nodes, graph.edges, graph.chips, comparison) : Promise.resolve(null),
    [graph, comparison],
  );
  const layout = useRequest(loadLayout);

  return { request, diff, layout, hasCollapsedContext: Boolean(graph?.chips.length) };
}
