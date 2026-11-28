import { useCallback } from "react";
import type { Ref } from "react";
import { fetchCode, fetchFunctionDiff } from "../api";
import type { FlagCheck, LineDiffRow, OverlayNode } from "../types";
import { useRequest } from "../useRequest";
import { LineCounts } from "./LineCounts";
import { nodeStyle, shortFilePath, statusLabels, symbolName } from "./styles";

const CONTEXT_LINES = 3;

interface CodePaneProps {
  repo: string;
  head?: string;
  node?: OverlayNode;
  check?: FlagCheck;
  nodes: OverlayNode[];
  open: boolean;
  headingRef?: Ref<HTMLDivElement>;
  onOpenChange: (open: boolean) => void;
  onSelect: (node: OverlayNode) => void;
  onClear: () => void;
}

function CodeDiffRows({ rows, name }: { rows: LineDiffRow[]; name: string }) {
  return (
    <pre className="code-pane__snippet" tabIndex={0} aria-label={`Diff for ${name}`}>
      <code>
        {rows.map(({ kind, base_line, head_line, text }) => (
          <span key={`${base_line}:${head_line}`} className={`code-line code-line--${kind}`}>
            <span className="code-line__number" data-revision="base">{base_line}</span>
            <span className="code-line__number" data-revision="head">{head_line}</span>
            <span className="code-line__marker">{kind === "added" ? "+" : kind === "removed" ? "−" : ""}</span>
            <span>{text}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

export function ChangedFunctions({ nodes, onSelect }: Pick<CodePaneProps, "nodes" | "onSelect">) {
  const changed = nodes.filter(({ kind, status }) =>
    (kind === "function" || kind === "method") && status !== "context",
  );
  return (
    <div className="code-pane__empty">
      <p className="muted">Click a function in the flow to see what changed</p>
      {changed.length > 0 && (
        <ul className="changed-functions" aria-label="Changed functions">
          {changed.map((node) => (
            <li key={node.id}>
              <button type="button" className="changed-functions__select" onClick={() => onSelect(node)}>
                <code className="changed-functions__name">{symbolName(node)}</code>
                <code className="muted" title={node.file}>{shortFilePath(node.file)}</code>
                <LineCounts added={node.lines_added} removed={node.lines_removed} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CodePane({ repo, head, node, check, nodes, open, headingRef, onOpenChange, onSelect, onClear }: CodePaneProps) {
  const nodeId = node?.file ? node.id : undefined;
  const loadCode = useCallback(async (signal: AbortSignal) => {
    if (!open || !head) return null;
    // The flow and the function diff both use the commit index's default base.
    if (nodeId) return { diff: await fetchFunctionDiff(repo, head, nodeId, signal) };
    if (check) {
      const { file, line } = check;
      return { snippet: await fetchCode(repo, head, file, Math.max(1, line - CONTEXT_LINES), line + CONTEXT_LINES, signal) };
    }
    return null;
  }, [repo, head, nodeId, check, open]);
  const code = useRequest(loadCode);
  const data = code.status === "ready" ? code.data : null;
  const diff = data?.diff;
  const snippet = data?.snippet;
  const name = node && symbolName(node);
  const status = diff?.status ?? node?.status;
  const file = diff?.file ?? node?.file ?? check?.file;
  const selected = Boolean(node || check);

  return (
    <section className="code-pane" id="source-code" aria-labelledby="code-pane-title">
      <div className="panel-heading" ref={headingRef}>
        <h2 id="code-pane-title">Source code</h2>
        {open && selected && (
          <div className="code-pane__location">
            {name && <code className="code-pane__name" title={name}>{name}</code>}
            {file && <code className="muted" title={file}>{shortFilePath(file)}{check && `:${check.line}`}</code>}
            {status && <span className="status-chip" style={nodeStyle(status)}>{statusLabels[status]}</span>}
            {check && head && <code className="muted" title={head}>Head {head.slice(0, 7)}</code>}
            {node && <LineCounts added={diff?.lines_added ?? node.lines_added} removed={diff?.lines_removed ?? node.lines_removed} />}
          </div>
        )}
        <div className="code-pane__actions">
          {open && selected && <button type="button" className="btn btn--sm" onClick={onClear}>Clear selection</button>}
          <button type="button" className="btn btn--sm" aria-expanded={open} aria-controls="source-content"
            onClick={() => onOpenChange(!open)}>{open ? "Hide" : "Show"}</button>
        </div>
      </div>
      <div className="code-pane__body" id="source-content" hidden={!open}>
        {!selected && <ChangedFunctions nodes={nodes} onSelect={onSelect} />}
        {selected && !file && <p className="panel-message">Source is unavailable for this node.</p>}
        {file && code.status === "loading" && <p className="panel-message" role="status">Loading source…</p>}
        {code.status === "error" && <p className="panel-message" role="alert">{code.message}</p>}
        {diff && name && <CodeDiffRows rows={diff.rows} name={name} />}
        {snippet && check && (
          <pre className="code-pane__snippet" tabIndex={0} aria-label={`Source for ${check.file}:${check.line}`}>
            <code>
              {snippet.lines.map(({ number, text }) => (
                <span key={number} className={number === check.line ? "code-line is-highlighted" : "code-line"}>
                  <span className="code-line__number">{number}</span>
                  <span>{text}</span>
                </span>
              ))}
            </code>
          </pre>
        )}
      </div>
    </section>
  );
}
