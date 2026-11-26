import { useCallback } from "react";
import { fetchCode } from "../api";
import type { NodeStatus } from "../types";
import { useRequest } from "../useRequest";
import { nodeStyle, statusLabels } from "./styles";

const CONTEXT_LINES = 3;

interface CodePaneProps {
  repo: string;
  source: CodeSource;
  onClose: () => void;
}

export interface CodeSource {
  sha: string;
  revision: "Head" | "Base";
  file: string;
  line: number;
  endLine: number;
  name: string;
  status?: NodeStatus;
}

export function CodePane({ repo, source, onClose }: CodePaneProps) {
  const { sha, revision, file, line, endLine, name, status } = source;
  const loadCode = useCallback(
    (signal: AbortSignal) => file
      ? fetchCode(repo, sha, file, Math.max(1, line - CONTEXT_LINES), endLine + CONTEXT_LINES, signal)
      : Promise.resolve(null),
    [repo, sha, file, line, endLine],
  );
  const code = useRequest(loadCode);

  return (
    <aside className="drawer code-pane" aria-labelledby="code-pane-title">
      <div className="panel-heading">
        <h2 id="code-pane-title">Source code</h2>
        <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close source code">
          Close
        </button>
      </div>
      <div className="code-pane__location">
        <code title={file}>{file ? `${file}:${line}` : name}</code>
        <div className="code-pane__meta">
          {status && <span className="status-chip" style={nodeStyle(status)}>{statusLabels[status]}</span>}
          <code title={sha}>{revision} {sha.slice(0, 7)}</code>
        </div>
      </div>
      {!file && <p className="panel-message">Source is unavailable for this node.</p>}
      {file && code.status === "loading" && <p className="panel-message" role="status">Loading source…</p>}
      {code.status === "error" && <p className="panel-message" role="alert">{code.message}</p>}
      {code.status === "ready" && code.data && (
        <pre className="code-pane__snippet" tabIndex={0} aria-label={`Source for ${name}`}>
          <code>
            {code.data.lines.map(({ number, text }) => (
              <span
                key={number}
                className={number >= line && number <= endLine ? "code-line is-highlighted" : "code-line"}
              >
                <span className="code-line__number">{number}</span>
                <span>{text}</span>
              </span>
            ))}
          </code>
        </pre>
      )}
    </aside>
  );
}
