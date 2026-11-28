import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { refreshRepo } from "../../api";
import { recordReviewEvent } from "../../events";
import type { ReviewContext, ReviewEvent } from "../../events";
import { directionExposureKey, readFlowDirection, useCodeFlowFlags, useDirectionExposure } from "../../flags";
import type { FlowLayout } from "../../layout/elk";
import { importProgress } from "../../pages/importHelpers";
import { pollRepoStatus } from "../../pollRepoStatus";
import { navigate, repoPath } from "../../router";
import { trackSignin } from "../../signinEvents";
import type { DiffViewModel, FlagCheck, FlagFinding, OverlayNode, RepoFlags, TimelineCommit } from "../../types";
import { useDiff, useDiffLayout } from "../../useDiff";
import type { Hops } from "../../useDiff";
import { useRepoFlags } from "../../useRepoFlags";
import { parseFlowDirection, parseFlowView } from "../../view";
import type { FlowDirection, FlowView } from "../../view";
import type { ExpandedContext } from "../../views/collapse";
import { liveFlagStates, toggleFlagSelection } from "../../views/flagFindings";
import { useDiagramFullscreen } from "../../views/fullscreen";
import type { DiagramFullscreen } from "../../views/fullscreen";
import { layoutPositionKey, useLayoutPositions } from "../../views/layoutPositions";
import type { LayoutPositionControls } from "../../views/layoutPositions";
import { hasFlowChange, nearestFlowChange, resolveCommit } from "../../views/timelineHelpers";
import { recordFlowViewOpened } from "../journey";
import { loadReview } from "./useReviewData";
import type { ReviewData } from "./useReviewData";

const guidePreference = "code-flow:diagram-guide";
const sourcePreference = "code-flow:source-code";
const checkingCommits = "Checking for new commits…";

export type RefreshState =
  | { status: "running"; text: string }
  | { status: "ready" | "error"; text: string; head: string | undefined };

// Everything the review screen shows and does for one repo.
export interface RepoReviewModel {
  name: string;
  subdir: string | null;
  url: string | null;
  branch: string;
  hasNodes: boolean;
  commits: TimelineCommit[];
  // The commit under review: ?commit=, else the newest.
  selected: TimelineCommit | undefined;
  head: string | undefined;
  commitTitle: string;
  selectCommit(sha: string): void;
  commitHref(sha: string): string;
  // The nearest commit with flow changes, when the selected one has none.
  nextChange: ReturnType<typeof nearestFlowChange>;
  refresh: RefreshState | null;
  checkForNewCommits(): void;
  // The flow view and direction, and where each value came from.
  flowChanged: boolean | undefined;
  view: FlowView;
  viewOverride: string | null;
  assignedView: FlowView | null;
  viewSource: string;
  direction: FlowDirection;
  directionOverride: string | null;
  assignedDirection: FlowDirection | null;
  directionSource: string;
  directionReady: boolean;
  longFlow: boolean | undefined;
  flagsReady: boolean;
  variantPreview: boolean;
  hops: Hops;
  setHops(hops: Hops): void;
  // The diagram
  diff: DiffViewModel | null;
  request: ReturnType<typeof useDiff>;
  layout: ReturnType<typeof useDiffLayout>["layout"];
  currentLayout: FlowLayout | null;
  hasCollapsedContext: boolean;
  contextExpanded: boolean;
  toggleContext(): void;
  expandModule(module: string): void;
  layoutPositions: LayoutPositionControls;
  fullscreen: DiagramFullscreen;
  markRendered(): void;
  guideOpen: boolean;
  setGuide(open: boolean): void;
  guideButton: RefObject<HTMLButtonElement | null>;
  // The review question under the diagram
  reviewContext: ReviewContext | null;
  sendsReviewEvents: boolean;
  onReview(payload: ReviewEvent): void;
  // Changes when the question should start again (another commit, view or direction).
  reviewKey: string;
  // The selected node and check, shown in the source pane
  selectedNode: OverlayNode | undefined;
  selectNode(node: OverlayNode): void;
  selectedCheck: FlagCheck | undefined;
  openCheck(check: FlagCheck): void;
  clearSelection(): void;
  sourceOpen: boolean;
  setSourceOpen(open: boolean): void;
  workspace: RefObject<HTMLDivElement | null>;
  sourceHeading: RefObject<HTMLDivElement | null>;
  // Flagsmith findings for this commit, and the flag picked from them
  findings: ReturnType<typeof useRepoFlags>;
  flags: RepoFlags | undefined;
  flagsmithMode: boolean;
  // live_flag_panel: shows the Live from Flagsmith findings list and lets a flag be picked from it
  liveFlagPanel: boolean;
  liveStates: ReturnType<typeof liveFlagStates>;
  selectedFlag: FlagFinding | undefined;
  selectFlag(finding: FlagFinding): void;
}

function readPanelPreference(key: string) {
  try {
    return window.localStorage.getItem(key) !== "closed";
  } catch {
    return true;
  }
}

function savePanelPreference(key: string, open: boolean) {
  try {
    window.localStorage.setItem(key, open ? "open" : "closed");
  } catch {
    // Toggling a panel still works when storage is blocked.
  }
}

function pinCurrentCommit(commits: TimelineCommit[]) {
  const location = new URL(window.location.href);
  if (location.searchParams.has("commit")) return location.searchParams.get("commit");
  const current = resolveCommit(commits, null);
  if (!current) return null;
  location.searchParams.set("commit", current.sha);
  navigate(location.href, { replace: true });
  return current.sha;
}

export function useRepoReview(id: string, search: string, initial: ReviewData): RepoReviewModel {
  const [review, setReview] = useState(initial);
  const { name, subdir, url, branch, hasNodes, commits } = review;
  const {
    flowView: view, reviewerId, viewOverride, directionOverride, variantPreview, flagsmithMode,
    liveFlagPanel, ready: flagsReady, assignedView, reviewEventClient, directionFlag,
  } = useCodeFlowFlags(search);
  const selected = resolveCommit(commits, new URLSearchParams(search).get("commit"));
  const head = selected?.sha;
  const [refresh, setRefresh] = useState<RefreshState | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  if (refresh && refresh.status !== "running" && refresh.head !== head) setRefresh(null);
  useEffect(() => () => refreshRequest.current?.abort(), []);
  const findings = useRepoFlags(id, flagsmithMode ? head : undefined);
  const flags = findings.status === "ready" ? findings.data : undefined;
  const liveStates = useMemo(() => liveFlagStates(flags), [flags]);
  const [flagSelection, setFlagSelection] = useState<{
    head: string | undefined; finding: FlagFinding;
  }>();
  const selectedFlag = liveFlagPanel
    && flags?.flags.some((flag) => flag.name === flagSelection?.finding.name)
    && flagSelection?.head === head ? flagSelection?.finding : undefined;
  const checkIds = useMemo(() => selectedFlag?.checks.map((check) => check.function), [selectedFlag]);
  const [hops, setHops] = useState<Hops>(1);
  const [guideOpen, setGuideOpen] = useState(() => readPanelPreference(guidePreference));
  const [sourceOpen, setSourceOpenState] = useState(() => readPanelPreference(sourcePreference));
  const guideButton = useRef<HTMLButtonElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const sourceHeading = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<{ head: string | undefined; expanded: ExpandedContext }>(
    () => ({ head, expanded: new Set() }),
  );
  if (context.head !== head) setContext({ head, expanded: new Set() });
  const [selection, setSelection] = useState<
    { head: string; nodeId: string } | { head: string; check: FlagCheck } | null
  >(null);
  const [rendered, setRendered] = useState<{
    layout: FlowLayout; view: FlowView; direction: FlowDirection;
  } | null>(null);
  const request = useDiff(id, hasNodes ? head : undefined, hops);
  const diff = request.status === "ready" ? request.data : null;
  const longFlow = diff ? diff.long_flow === true : undefined;
  const { direction, assignedDirection, ready: directionReady } = readFlowDirection(
    directionOverride, longFlow, directionFlag,
  );
  const { layout, hasCollapsedContext } = useDiffLayout(
    diff, context.expanded, view === "side_by_side", direction, checkIds,
  );
  const currentLayout = layout.status === "ready" ? layout.data : null;
  const layoutPositions = useLayoutPositions(layoutPositionKey(id, head ?? "", view, direction));
  const contextExpanded = context.expanded === "all" || context.expanded.size > 0;
  const currentSelection = selection?.head === head ? selection : null;
  const selectedNode = currentSelection && "nodeId" in currentSelection
    ? diff?.nodes.find(({ id }) => id === currentSelection.nodeId) : undefined;
  const selectedCheck = currentSelection && "check" in currentSelection ? currentSelection.check : undefined;
  const markRendered = useCallback(() => {
    if (currentLayout) setRendered({ layout: currentLayout, view, direction });
  }, [currentLayout, view, direction]);
  const diagramRendered = Boolean(currentLayout && rendered?.layout === currentLayout
    && rendered.view === view && rendered.direction === direction);
  useEffect(() => {
    if (!diagramRendered) return;
    // Ends the github_signin journey clock; it only counts after an import was started.
    trackSignin("first_flow_viewed");
    recordFlowViewOpened(id);
  }, [diagramRendered, id]);
  const previewOverride = viewOverride ?? directionOverride;
  const exposureKey = directionExposureKey(reviewerId, longFlow, previewOverride, directionFlag);
  const layoutReview = useDirectionExposure(reviewerId, exposureKey, diagramRendered);
  const reviewContext = diff && diagramRendered && layoutReview.ready
    ? { repo: id, view, reviewerId, head: diff.head, base: diff.base, devOverride: previewOverride !== null }
    : null;
  const flowChanged = selected && hasFlowChange(selected.stats);
  const fullscreen = useDiagramFullscreen(Boolean(flowChanged && layout.status === "ready" && layout.data?.nodes.length));
  const nextChange = selected && !flowChanged ? nearestFlowChange(commits, selected.sha) : null;
  const viewSource = variantPreview && parseFlowView(viewOverride) ? "Preview"
    : !flagsReady ? "Loading assignment…" : assignedView ? "Assigned by Flagsmith" : "Default";
  const directionSource = variantPreview && parseFlowDirection(directionOverride) ? "Preview"
    : assignedDirection ? "Assigned by Flagsmith" : longFlow === false ? "Default for short flows" : "Default";

  useEffect(() => {
    if (!selectedFlag) return;
    function clearHighlight(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) setFlagSelection(undefined);
    }
    window.addEventListener("keydown", clearHighlight);
    return () => window.removeEventListener("keydown", clearHighlight);
  }, [selectedFlag]);

  const commitHref = useCallback((sha: string) => {
    const params = new URLSearchParams(search);
    params.set("commit", sha);
    return `${repoPath(id)}?${params}`;
  }, [id, search]);

  const selectCommit = useCallback((sha: string) => {
    if (sha !== head) {
      setFlagSelection(undefined);
      setSelection(null);
      navigate(commitHref(sha));
    }
  }, [commitHref, head]);

  async function checkForNewCommits() {
    if (refreshRequest.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    refreshRequest.current = controller;
    setRefresh({ status: "running", text: checkingCommits });
    try {
      const job = await refreshRepo(id, signal);
      const status = await pollRepoStatus(job.id, signal, (update) => {
        const progress = importProgress(job.status, update);
        if (update.status === "analyzing" && progress.progress) {
          setRefresh({ status: "running", text: progress.text });
        }
      });
      if (status.status === "error") throw new Error(importProgress(job.status, status).text);

      pinCurrentCommit(commits);
      const updated = await loadReview(id, signal);
      if (signal.aborted) return;
      // The reviewer can navigate while the new history loads.
      const next = resolveCommit(updated.commits, pinCurrentCommit(commits));
      // A refresh can join a regular import, which has no refresh count.
      const oldShas = new Set(commits.map(({ sha }) => sha));
      const count = status.new_commits ?? updated.commits.filter(({ sha }) => !oldShas.has(sha)).length;
      const text = count === 0 ? "Up to date" : `${count} new commit${count === 1 ? "" : "s"}`;
      setReview(updated);
      setRefresh({ status: "ready", head: next?.sha, text });
    } catch (error) {
      if (!signal.aborted) {
        const current = resolveCommit(commits, new URLSearchParams(window.location.search).get("commit"));
        const detail = error instanceof Error ? error.message : "Something went wrong.";
        setRefresh({ status: "error", head: current?.sha, text: `Couldn't check for new commits: ${detail}` });
      }
    } finally {
      refreshRequest.current = null;
    }
  }

  function setGuide(open: boolean) {
    setGuideOpen(open);
    savePanelPreference(guidePreference, open);
  }

  function setSourceOpen(open: boolean) {
    setSourceOpenState(open);
    savePanelPreference(sourcePreference, open);
  }

  function selectNode(node: OverlayNode) {
    if (head) setSelection({ head, nodeId: node.id });
    setSourceOpenState(true);
  }

  function openCheck(check: FlagCheck) {
    if (head) setSelection({ head, check });
    setSourceOpenState(true);
  }

  function clearSelection() {
    setSelection(null);
  }

  function selectFlag(finding: FlagFinding) {
    const name = toggleFlagSelection(selectedFlag?.name, finding.name);
    setFlagSelection(name ? { head, finding } : undefined);
  }

  function toggleContext() {
    setContext({ head, expanded: hasCollapsedContext ? "all" : new Set() });
  }

  function expandModule(module: string) {
    setContext(({ expanded }) => ({
      head, expanded: expanded === "all" ? expanded : new Set([...expanded, module]),
    }));
  }

  function onReview(payload: ReviewEvent) {
    recordReviewEvent(payload, reviewEventClient, layoutReview);
  }

  return {
    name, subdir, url, branch, hasNodes, commits, selected, head,
    commitTitle: selected?.message || "Untitled commit",
    selectCommit, commitHref, nextChange, refresh, checkForNewCommits,
    flowChanged, view, viewOverride, assignedView, viewSource,
    direction, directionOverride, assignedDirection, directionSource, directionReady, longFlow,
    flagsReady, variantPreview, hops, setHops,
    diff, request, layout, currentLayout, hasCollapsedContext, contextExpanded, toggleContext, expandModule,
    layoutPositions, fullscreen, markRendered, guideOpen, setGuide, guideButton,
    reviewContext,
    sendsReviewEvents: reviewEventClient !== null || layoutReview.exposed,
    onReview,
    reviewKey: JSON.stringify([id, head, view, reviewerId, viewOverride, direction, directionOverride]),
    selectedNode, selectNode, selectedCheck, openCheck, clearSelection, sourceOpen, setSourceOpen,
    workspace, sourceHeading,
    findings, flags, flagsmithMode, liveFlagPanel, liveStates, selectedFlag, selectFlag,
  };
}
