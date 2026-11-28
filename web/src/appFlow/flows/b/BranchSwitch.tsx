// Flow B's branch switch: the branch button in the flow view's top bar opens a 416 px dropdown under
// it. The dropdown lists the branches and analyzes the picked one inside itself (B6 and B6b in the
// designs). Data and actions come only from useBranchSwitch, which also records the opening and
// navigates to the new branch when its analysis is ready.
import { useEffect, useId, useRef, useState } from "react";
import { importSteps } from "../../../pages/importHelpers";
import type { GitHubCommitList, RepoBranches, RepoStatus } from "../../../types";
import type { RequestState } from "../../../useRequest";
import { formatCommitDate } from "../../../views/timelineHelpers";
import { useBranchSwitch } from "../../hooks/useBranchSwitch";
import type { BranchSwitch } from "../../hooks/useBranchSwitch";
import { Button } from "../../ui/Button";
import { Icon, StatusStrip } from "./kit";
import "./flowview.css";

const analyzingStatuses: readonly RepoStatus[] = ["queued", "cloning", "analyzing"];
const importStepLabels = importSteps.map(({ label }) => label);

export function BranchSwitchB({ repoId, currentBranch }: { repoId: string; currentBranch: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const switcher = useBranchSwitch(repoId, open);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) returnTo(root.current)?.focus();
  }

  // Escape and a press outside the switch close the panel. Escape also returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) close(true);
    }
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      close(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  const { progress } = switcher;
  return (
    <div className="fb-branch" ref={root}>
      <Button
        className="fb-branch__trigger"
        aria-label={`${currentBranch}: switch branch`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <Icon name="branch" />
        <code>{currentBranch}</code>
        <Icon name="chevron-down" />
      </Button>
      {progress && !open && <span className="fb-branch__busy">{progress.text}</span>}
      {open && (
        <div id={panelId} ref={panel} className="fb-branch__panel" role="dialog" aria-label="Switch branch" tabIndex={-1}>
          <div className="fb-branch__head">
            <h2>
              <Icon name="branch" />
              Branches
            </h2>
            <Button variant="tertiary" size="sm" aria-label="Close branches" onClick={() => close(true)}>
              <Icon name="close" />
            </Button>
          </div>
          <BranchList switcher={switcher} currentBranch={currentBranch} />
          {switcher.selected !== null && <BranchPreview switcher={switcher} name={switcher.selected} />}
        </div>
      )}
    </div>
  );
}

// The button that opened this switch, which gets focus back when the panel closes.
function returnTo(root: HTMLElement | null) {
  return root?.querySelector<HTMLButtonElement>(".fb-branch__trigger") ?? null;
}

function BranchList({ switcher, currentBranch }: { switcher: BranchSwitch; currentBranch: string }) {
  const { info, selected, select } = switcher;
  if (info.status === "loading") return <p className="fb-branch__status" role="status">Loading branches…</p>;
  if (info.status === "error") return <p className="fb-branch__error" role="alert">{info.message}</p>;

  return (
    <ul className="fb-branch__list" aria-label="Branches">
      {info.data.branches.map((name) => (
        <li key={name}>
          <button
            type="button"
            className="fb-branch__row"
            aria-pressed={selected === name}
            aria-current={name === currentBranch ? "true" : undefined}
            onClick={() => select(name)}
          >
            <span className="fb-branch__name">
              {name === currentBranch && <Icon name="check" />}
              <code>{name}</code>
              {name === info.data.default_branch && <span className="fb-branch__chip">default</span>}
            </span>
            <BranchStatus status={analysisStatus(info.data, name)} />
          </button>
        </li>
      ))}
    </ul>
  );
}

// The branch's analysis: analyzed, being analyzed, or not analyzed yet. An errored import counts as not analyzed.
function BranchStatus({ status }: { status: RepoStatus | null }) {
  if (status === "ready") {
    return <span className="fb-branch__chip fb-branch__chip--analyzed"><Icon name="check" />Analyzed</span>;
  }
  if (status !== null && analyzingStatuses.includes(status)) return <span className="fb-branch__chip">Analyzing…</span>;
  return <span className="fb-branch__chip">Not analyzed</span>;
}

// The picked branch: its latest commits, then either the analysis progress, the error with a retry,
// or the button that analyzes it (or opens it when it is already analyzed).
function BranchPreview({ switcher, name }: { switcher: BranchSwitch; name: string }) {
  const { info, commits, analyze, progress, error } = switcher;
  const status = info.status === "ready" ? analysisStatus(info.data, name) : null;
  const ready = status === "ready";
  const limit = commits.status === "ready" ? commits.data.limit : undefined;
  const actionLabel = ready ? "Open" : limit === undefined ? "Analyze commits" : `Analyze ${limit} commits`;

  return (
    <section className="fb-branch__preview" aria-label={`Latest commits on ${name}`}>
      <div className="fb-branch__title">
        <h3>{limit === undefined ? "Latest commits on" : `Latest ${limit} commits on`}</h3>
        <code>{name}</code>
        {info.status === "ready" && <BranchStatus status={status} />}
      </div>
      {!ready && limit !== undefined && (
        <p className="fb-branch__hint">
          Up to {limit} commits, set by the <code>branch_commit_count</code> feature flag.
        </p>
      )}
      <CommitRows commits={commits} />
      {progress ? (
        <AnalysisProgress progress={progress} />
      ) : error ? (
        <div className="fb-branch__error" role="alert">
          <span>{error}</span>
          <Button onClick={analyze}>Try again</Button>
        </div>
      ) : (
        <div className="fb-branch__actions">
          <Button variant="primary" disabled={commits.status !== "ready"} onClick={analyze}>
            {actionLabel}
          </Button>
        </div>
      )}
    </section>
  );
}

function CommitRows({ commits }: { commits: RequestState<GitHubCommitList> }) {
  if (commits.status === "loading") return <p className="fb-branch__status" role="status">Loading commits…</p>;
  if (commits.status === "error") return <p className="fb-branch__error" role="alert">{commits.message}</p>;
  if (commits.data.commits.length === 0) return <p className="fb-branch__status">This branch has no commits.</p>;

  return (
    <ol className="fb-branch__commits" aria-label="Commits on this branch">
      {commits.data.commits.map((commit) => (
        <li key={commit.sha}>
          <code>{commit.sha.slice(0, 7)}</code>
          <span title={commit.message}>{commit.message}</span>
          <time dateTime={commit.date}>{formatCommitDate(commit.date, true)}</time>
        </li>
      ))}
    </ol>
  );
}

// The steps and the count from the hook. The counts only come while commits are being analyzed; a
// cloning message is the one other step the hook reports with text of its own.
function AnalysisProgress({ progress }: { progress: { text: string; current: number; total: number } }) {
  const step = progress.total > 0 ? 2 : /clon/i.test(progress.text) ? 1 : 0;
  const counted = progress.total > 0;
  return (
    <StatusStrip label="Import progress" steps={importStepLabels} current={step}>
      <div className="fb-branch__progress">
        <span>{progress.text}</span>
        <progress
          value={counted ? progress.current : undefined}
          max={counted ? progress.total : undefined}
          aria-label="Analysis progress"
        />
      </div>
    </StatusStrip>
  );
}

function analysisStatus(branches: RepoBranches, name: string): RepoStatus | null {
  return branches.analyzed.find((item) => item.branch === name)?.status ?? null;
}
