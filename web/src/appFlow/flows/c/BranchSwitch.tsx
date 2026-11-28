// Flow C branch switch: the branch chip in the commit card opens a 352 px popover with the branch
// list. A branch that is not analyzed shows its latest commits as a rail, and Analyze fills the rail
// in while the import runs. Data comes from useBranchSwitch, which also opens the new flow view
// when the analysis is ready.
import { useEffect, useId, useRef, useState } from "react";
import type { BranchSwitch } from "../../hooks/useBranchSwitch";
import { useBranchSwitch } from "../../hooks/useBranchSwitch";
import type { RequestState } from "../../../useRequest";
import type { GitHubCommitList } from "../../../types";
import { Button } from "../../ui/Button";
import { Icon } from "./kit";
import "./flowview.css";

export function BranchSwitchC({ repoId, currentBranch }: { repoId: string; currentBranch: string }) {
  const [open, setOpen] = useState(false);
  const branch = useBranchSwitch(repoId, open);
  const { info, selected, select, commits, analyze, progress, error } = branch;
  const id = useId();
  const titleId = `${id}-title`;
  const popoverId = `${id}-popover`;
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  // The branch whose analyzed flow view is already being opened, so it opens once.
  const opened = useRef<string | null>(null);

  const pickedAnalysis = info.status === "ready" && selected !== null
    ? info.data.analyzed.find((item) => item.branch === selected)
    : undefined;
  const opening = pickedAnalysis?.status === "ready";

  // Focus moves into the popover when it opens.
  useEffect(() => {
    if (open) popover.current?.focus();
  }, [open]);

  // Escape closes the popover and returns focus to the trigger. A press outside closes it too.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && wrapper.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // An analyzed branch opens as soon as its commits are known.
  useEffect(() => {
    if (!open || selected === null || !opening || commits.status !== "ready") return;
    if (opened.current === selected) return;
    opened.current = selected;
    analyze();
  }, [open, selected, opening, commits.status, analyze]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function choose(name: string) {
    if (name === currentBranch) close();
    else select(name);
  }

  return (
    <div className="fc-branch" ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className="fc-branch__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`Switch branch, currently ${currentBranch}`}
        onClick={() => setOpen(!open)}
      >
        <Icon name="branch" size={14} />
        <span className="fc-branch__current">{currentBranch}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div
          id={popoverId}
          ref={popover}
          className="fc-branch__popover"
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <div className="fc-branch__head">
            <h2 id={titleId} className="fc-branch__title">Switch branch</h2>
            <button type="button" className="fc-branch__close" aria-label="Close branch list" onClick={close}>
              <Icon name="close" size={14} />
            </button>
          </div>
          {info.status === "loading" && <p className="fc-branch__status" role="status">Loading branches…</p>}
          {info.status === "error" && <p className="fc-branch__error" role="alert">{info.message}</p>}
          {info.status === "ready" && (
            <ul className="fc-branch__list">
              {info.data.branches.map((name) => {
                const isCurrent = name === currentBranch;
                const analyzed = isCurrent || info.data.analyzed.some((item) => item.branch === name);
                const pressed = selected === null ? isCurrent : selected === name;
                return (
                  <li key={name}>
                    <button
                      type="button"
                      className="fc-branch__row"
                      aria-pressed={pressed}
                      aria-current={isCurrent ? "true" : undefined}
                      disabled={progress !== null}
                      onClick={() => choose(name)}
                    >
                      <span className="fc-branch__row-body">
                        <span className="fc-branch__row-name">
                          {name}
                          {name === info.data.default_branch && <span className="fc-branch__default"> · default</span>}
                        </span>
                        {analyzed
                          ? <span className="fc-branch__analyzed">Analyzed</span>
                          : <span className="fc-branch__row-meta">Not analyzed</span>}
                      </span>
                      <Icon name={isCurrent ? "check" : "chevron-right"} size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {info.status === "ready" && selected !== null && selected !== currentBranch && (
            <PickedBranch
              name={selected}
              opening={opening}
              commits={commits}
              progress={progress}
              error={error}
              onAnalyze={analyze}
            />
          )}
        </div>
      )}
    </div>
  );
}

// The latest commits of the picked branch as a rail of dots, with the Analyze button under it.
// While the import runs, the progress replaces the button and the dots fill in from the left.
function PickedBranch({ name, opening, commits, progress, error, onAnalyze }: {
  name: string;
  opening: boolean;
  commits: RequestState<GitHubCommitList>;
  progress: BranchSwitch["progress"];
  error: string | null;
  onAnalyze(): void;
}) {
  if (opening) {
    return (
      <div className="fc-branch__detail">
        <p className="fc-branch__status" role="status">Opening {name}…</p>
      </div>
    );
  }
  if (commits.status === "loading") {
    return (
      <div className="fc-branch__detail">
        <p className="fc-branch__status" role="status">Loading commits…</p>
      </div>
    );
  }
  if (commits.status === "error") {
    return (
      <div className="fc-branch__detail">
        <p className="fc-branch__error" role="alert">{commits.message}</p>
      </div>
    );
  }

  const shown = commits.data.commits;
  const count = shown.length;
  const noun = count === 1 ? "commit" : "commits";
  const percent = progress && progress.total > 0 ? (progress.current / progress.total) * 100 : 0;

  return (
    <div className="fc-branch__detail">
      {count > 0 ? (
        <p className="fc-branch__detail-title">Latest {count} {noun} on <code>{name}</code></p>
      ) : (
        <p className="fc-branch__detail-title">This branch has no commits.</p>
      )}
      {count > 0 && count < commits.data.limit && (
        <p className="fc-branch__status">This branch has {count} {noun}.</p>
      )}
      {count > 0 && (
        <ol className="fc-branch__rail" aria-label={`Commits on ${name}`}>
          {shown.map((commit, index) => {
            const label = `${commit.sha.slice(0, 7)} ${commit.message}`;
            const filled = progress !== null && index < progress.current;
            return (
              <li key={commit.sha}>
                <span className={filled ? "fc-branch__dot is-filled" : "fc-branch__dot"} title={label} />
                <span className="fc-branch__sr">{label}</span>
              </li>
            );
          })}
        </ol>
      )}
      {progress ? (
        <div className="fc-branch__progress">
          <p className="fc-branch__status" role="status">{progress.text}</p>
          <div className="fc-branch__bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : (
        count > 0 && (
          <Button variant="primary" onClick={onAnalyze}>
            Analyze {count} {noun}
          </Button>
        )
      )}
      {error && (
        <p className="fc-branch__error" role="alert">
          {error}{" "}
          <Button variant="tertiary" size="sm" onClick={onAnalyze}>Try again</Button>
        </p>
      )}
    </div>
  );
}
