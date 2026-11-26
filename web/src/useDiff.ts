import { useCallback, useMemo } from "react";
import { fetchDiff } from "./api";
import { layoutFlow } from "./layout/elk";
import type { DiffViewModel } from "./types";
import { useRequest } from "./useRequest";
import type { FlowDirection } from "./view";
import { collapseContext } from "./views/collapse";
import type { ExpandedContext } from "./views/collapse";

export type Hops = 1 | 2;

export function useDiff(repo: string, head: string | undefined, hops: Hops) {
  const loadDiff = useCallback(
    (signal: AbortSignal) => head ? fetchDiff(repo, head, { hops }, signal) : Promise.resolve(null),
    [repo, head, hops],
  );
  return useRequest(loadDiff);
}

export function useDiffLayout(
  diff: DiffViewModel | null, expanded: ExpandedContext, comparison: boolean, direction: FlowDirection | null,
  keepVisible?: readonly string[],
) {
  const graph = useMemo(
    () => diff ? collapseContext(diff.nodes, diff.edges, expanded, keepVisible) : null,
    [diff, expanded, keepVisible],
  );
  const loadLayout = useCallback(
    () => graph && direction ? layoutFlow(graph.nodes, graph.edges, graph.chips, comparison, direction) : Promise.resolve(null),
    [graph, comparison, direction],
  );
  const layout = useRequest(loadLayout);

  return { layout, hasCollapsedContext: Boolean(graph?.chips.length) };
}
