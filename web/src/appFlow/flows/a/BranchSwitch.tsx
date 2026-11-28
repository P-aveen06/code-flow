// Flow A "Guided" branch switch. The trigger shows the current branch; it opens a 640 px dialog with
// three steps: pick a branch, see its latest commits and analyze it, then watch the import. All data
// comes from useBranchSwitch. See docs/APP_FLOW_BUILD.md, "Branch switch contract".
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GitHubCommit } from "../../../types";
import { formatCommitDate } from "../../../views/timelineHelpers";
import { useBranchSwitch } from "../../hooks/useBranchSwitch";
import type { BranchSwitch } from "../../hooks/useBranchSwitch";
import { Button } from "../../ui/Button";
import { Callout, Chip, Icon } from "./kit";
import "./flowview.css";

const previewCount = 5;
const importSteps = ["Queued", "Cloning", "Analyzing", "Ready"];

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Keeps Tab and Shift+Tab inside the dialog, wrapping at both ends. Items inside a closed <details> are skipped.
const focusable = "a[href], button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";
function keepFocusInside(event: KeyboardEvent, dialog: HTMLElement) {
  const items = Array.from(dialog.querySelectorAll<HTMLElement>(focusable)).filter(
    (item) => item.tagName === "SUMMARY" || !item.closest("details:not([open])"),
  );
  const first = items[0] ?? dialog;
  const last = items[items.length - 1] ?? dialog;
  const active = document.activeElement;
  const outside = !dialog.contains(active);
  if (event.shiftKey) {
    if (outside || active === first || active === dialog) {
      event.preventDefault();
      last.focus();
    }
  } else if (outside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function BranchSwitchA({ repoId, currentBranch }: { repoId: string; currentBranch: string }) {
  const [open, setOpen] = useState(false);
  // True while the visitor is choosing a branch (step 1). False once a branch is picked (step 2).
  const [choosing, setChoosing] = useState(true);
  // The analyzed branch the visitor picked. It opens as soon as its latest commits are here.
  const [opening, setOpening] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const branch = useBranchSwitch(repoId, open);
  const { info, selected, commits, progress } = branch;
  const analyzed = new Set(
    info.status === "ready"
      ? info.data.analyzed.filter(({ status }) => status === "ready").map(({ branch: name }) => name)
      : [],
  );

  function openDialog() {
    setChoosing(true);
    setOpening(null);
    setOpen(true);
  }

  // Focus goes back to the trigger, the first button in this control.
  function closeDialog() {
    setOpen(false);
    setOpening(null);
    wrap.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }

  // While the dialog is open it takes the keyboard: Tab stays inside, Escape closes, and the flow's
  // own shortcuts (arrows, U, C, F) do not run underneath it.
  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
      } else if (event.key === "Tab" && dialog.current) {
        keepFocusInside(event, dialog.current);
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
    // closeDialog only uses state setters and the trigger ref, so it is not a dependency.
  }, [open]);

  // An analyzed branch opens straight away, once the hook has its commits (analyze needs them).
  useEffect(() => {
    if (opening === null || selected !== opening || commits.status !== "ready") return;
    setOpening(null);
    branch.analyze();
  }, [opening, selected, commits.status, branch.analyze]);

  function pick(name: string) {
    if (name === currentBranch) {
      closeDialog();
      return;
    }
    branch.select(name);
    setChoosing(false);
    setOpening(analyzed.has(name) ? name : null);
  }

  function back() {
    setChoosing(true);
    setOpening(null);
  }

  let body: ReactNode;
  if (progress) body = <ImportProgress progress={progress} />;
  else if (choosing || selected === null) {
    body = <BranchList branch={branch} currentBranch={currentBranch} analyzed={analyzed} onPick={pick} />;
  } else body = <BranchDetails branch={branch} selected={selected} opening={opening === selected} onBack={back} />;

  const fullName = info.status === "ready" ? info.data.full_name : repoId;

  return (
    <div className="fa-branch" ref={wrap}>
      <Button
        size="sm" className="fa-branch__trigger" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Switch branch, current branch ${currentBranch}`} title="Switch branch" onClick={openDialog}
      >
        <span>{currentBranch}</span>
        <Icon name="chevron-down" size={14} />
      </Button>
      {open && (
        <div
          className="fa-branch__overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="fa-branch__dialog">
            <div className="fa-branch__head">
              <span className="fa-branch__icon" aria-hidden="true"><Icon name="branch" size={22} /></span>
              <div className="fa-branch__heading">
                <h2 id={titleId}>{progress ? "Import progress" : "Switch branch"}</h2>
                <p>
                  <code>{fullName}</code>
                  {progress && selected && <> · <code>{selected}</code></>}
                </p>
              </div>
              <Button className="fa-branch__close" size="sm" aria-label="Close" onClick={closeDialog}>
                <Icon name="close" size={14} />
              </Button>
            </div>
            {body}
          </div>
        </div>
      )}
    </div>
  );
}

function BranchList({ branch, currentBranch, analyzed, onPick }: {
  branch: BranchSwitch;
  currentBranch: string;
  analyzed: Set<string>;
  onPick(name: string): void;
}) {
  const { info } = branch;
  if (info.status === "loading") return <p className="fa-branch__status" role="status">Loading branches…</p>;
  if (info.status === "error") return <Callout role="alert">Could not load branches. {info.message}</Callout>;

  return (
    <section className="fa-branch__step">
      <div className="fa-branch__step-head">
        <h3>Choose a branch</h3>
        <Chip tone="accent">Step 1 of 2</Chip>
      </div>
      <ul className="fa-branch__rows">
        {info.data.branches.map((name) => {
          const isAnalyzed = analyzed.has(name);
          return (
            <li key={name}>
              <Button
                className="fa-branch__row"
                aria-current={name === currentBranch ? "true" : undefined}
                onClick={() => onPick(name)}
              >
                <span className="fa-branch__name">
                  <Icon name="branch" size={14} />
                  <code>{name}</code>
                  {name === info.data.default_branch && <Chip tone="accent">Default</Chip>}
                  {name === currentBranch && <Chip>Current</Chip>}
                </span>
                <span className="fa-branch__state">
                  <Chip tone={isAnalyzed ? "accent" : "neutral"}>{isAnalyzed ? "Analyzed" : "Not analyzed"}</Chip>
                  <Icon name="chevron-right" size={16} />
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BranchDetails({ branch, selected, opening, onBack }: {
  branch: BranchSwitch;
  selected: string;
  opening: boolean;
  onBack(): void;
}) {
  const { commits, error } = branch;
  const ready = commits.status === "ready";
  const list = ready ? commits.data.commits : [];
  const count = list.length;
  const limit = ready ? commits.data.limit : 0;

  return (
    <section className="fa-branch__step">
      <div className="fa-branch__step-head">
        <Button variant="tertiary" size="sm" onClick={onBack}>
          <Icon name="arrow-left" size={14} />All branches
        </Button>
        <Chip tone="accent">Step 2 of 2</Chip>
      </div>
      <h3>
        Latest {ready && count > 0 ? plural(count, "commit") : "commits"} on <code>{selected}</code>
      </h3>
      {commits.status === "loading" && <p className="fa-branch__status" role="status">Loading commits…</p>}
      {commits.status === "error" && <Callout role="alert">Could not load the commits. {commits.message}</Callout>}
      {ready && (
        <>
          <p className="fa-branch__hint">
            {count === 0 && "This branch has no commits."}
            {count > 0 && count < limit && `This branch has ${count}.`}
            {count >= limit && count > 0 && (
              <>Up to {limit} commits, set by the <code>branch_commit_count</code> feature flag.</>
            )}
          </p>
          {count > 0 && (
            <>
              <ul className="fa-branch__commits">
                {list.slice(0, previewCount).map((commit) => <CommitLine key={commit.sha} commit={commit} />)}
              </ul>
              {count > previewCount && (
                <details className="fa-branch__more">
                  <summary>Show all</summary>
                  <ul className="fa-branch__commits">
                    {list.slice(previewCount).map((commit) => <CommitLine key={commit.sha} commit={commit} />)}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}
      {error && <Callout role="alert">Could not analyze this branch. {error}</Callout>}
      {opening ? (
        <p className="fa-branch__status" role="status">Opening {selected}…</p>
      ) : (
        <div className="fa-branch__actions">
          <Button variant="primary" disabled={!ready || count === 0} onClick={() => branch.analyze()}>
            {error ? "Try again" : ready ? `Analyze ${plural(count, "commit")}` : "Analyze commits"}{" "}
            <Icon name="arrow-right" size={16} />
          </Button>
        </div>
      )}
    </section>
  );
}

function CommitLine({ commit }: { commit: GitHubCommit }) {
  return (
    <li className="fa-branch__commit">
      <a href={commit.url} target="_blank" rel="noreferrer" className="fa-branch__sha">
        <code>{commit.sha.slice(0, 7)}</code>
      </a>
      <span className="fa-branch__message">{commit.message}</span>
      <span className="fa-branch__meta">{commit.author} · {formatCommitDate(commit.date)}</span>
    </li>
  );
}

function ImportProgress({ progress }: { progress: { text: string; current: number; total: number } }) {
  const counting = progress.total > 0;
  const percent = counting ? Math.round((progress.current / progress.total) * 100) : 0;
  // The hook reports commit counts only once the analysis is running; before that the import is queued.
  const activeStep = counting ? 2 : 0;

  return (
    <section className="fa-branch__progress" aria-label="Import progress">
      <ol className="fa-branch__steps">
        {importSteps.map((label, index) => {
          const state = index < activeStep ? "done" : index === activeStep ? "current" : "upcoming";
          return (
            <li key={label} className={`fa-branch__step-item fa-branch__step-item--${state}`} aria-current={state === "current" ? "step" : undefined}>
              <span className="fa-branch__marker">{state === "done" ? <Icon name="check" size={14} /> : index + 1}</span>
              <span className="fa-branch__step-label">{label}</span>
            </li>
          );
        })}
      </ol>
      <div className="fa-branch__bar-head">
        <p role="status">{progress.text}</p>
        {counting && <span>{percent}%</span>}
      </div>
      <div
        className="fa-branch__bar" role="progressbar" aria-label="Analyzing commits"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </section>
  );
}
