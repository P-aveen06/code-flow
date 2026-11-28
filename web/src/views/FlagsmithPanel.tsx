import { useEffect, useState } from "react";
import type { FlagCheck, FlagFinding, RepoFlags } from "../types";
import { flagConnectionText, flagStatusText, groupFlagFindings } from "./flagFindings";

interface FlagFindingsProps {
  data?: RepoFlags;
  error?: string;
  loading: boolean;
  selected?: string;
  onSelect: (finding: FlagFinding) => void;
  onOpenCheck: (check: FlagCheck) => void;
}

interface FlagsmithPanelProps extends FlagFindingsProps {
  view: { value: string; source: string };
  direction: { value: string; source: string };
  enabled: boolean;
}

const groupDescriptions = {
  orphan: "Checked in code and missing from Flagsmith",
  unused: "In Flagsmith with no checks in this commit",
};

export function FlagsmithPanel({ view, direction, enabled, ...findings }: FlagsmithPanelProps) {
  return (
    <section className="flagsmith-panel" aria-labelledby="flagsmith-title">
      <div className="panel-heading"><h2 id="flagsmith-title">Flagsmith</h2></div>
      <div className="flagsmith-panel__body">
        <div className="flagsmith-panel__review">
          <h3>This review</h3>
          <dl>
            <dt>Flow view</dt>
            <dd>{view.value}<small>{view.source}</small></dd>
            <dt>Flow direction</dt>
            <dd>{direction.value}<small>{direction.source}</small></dd>
          </dl>
        </div>
        {enabled ? <FlagFindings {...findings} /> : (
          <p className="flagsmith-panel__findings muted">Flag checks are off (flagsmith_mode)</p>
        )}
      </div>
    </section>
  );
}

function FlagFindings({ data, error, loading, selected, onSelect, onOpenCheck }: FlagFindingsProps) {
  const [now, setNow] = useState(Date.now);
  const connected = data?.flagsmith.connected;
  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [connected]);

  const groups = groupFlagFindings(data?.flags ?? []);
  const connection = data ? flagConnectionText(data.flagsmith, now) : error;

  return (
    <div className="flagsmith-panel__findings">
      {connection && <p className="muted flagsmith-panel__connection">{connection}</p>}
      {loading && <p className="muted" role="status">Loading Flagsmith findings…</p>}
      {!loading && !error && groups.length === 0 && (
        <p className="empty-state">No Flagsmith flag checks in this commit's flow</p>
      )}
      {groups.map(({ status, findings }) => (
        <section key={status} className="flag-group" aria-label={flagStatusText[status]}>
          <h3>{flagStatusText[status]}</h3>
          {(status === "orphan" || status === "unused") && (
            <p className="muted">{groupDescriptions[status]}</p>
          )}
          <ul className="flag-group__list">
            {findings.map((finding) => (
              <li key={finding.name} className="flag-finding">
                <button
                  className="btn btn--sm flag-finding__select"
                  type="button"
                  aria-pressed={selected === finding.name}
                  title="Highlight guarded paths in the diagram"
                  onClick={() => onSelect(finding)}
                >
                  <code>{finding.name}</code>
                  <span className="flag-finding__meta">
                    <span className="status-chip flag-status" data-status={status}>{flagStatusText[status]}</span>
                    {finding.stale && <span className="status-chip flag-status" data-status="stale">Stale</span>}
                    <span className="muted">{finding.guarded_edges.length} guarded {finding.guarded_edges.length === 1 ? "call" : "calls"}</span>
                  </span>
                </button>
                {finding.checks.length > 0 && (
                  <ul className="flag-finding__checks">
                    {finding.checks.map((check, index) => (
                      <li key={`${check.file}:${check.line}:${index}`}>
                        <button type="button" className="flag-finding__location" onClick={() => onOpenCheck(check)}>
                          <code>{check.file}:{check.line}</code>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {finding.stale && (
                  <div className="muted flag-finding__stale">
                    {finding.stale_reason && <p>{finding.stale_reason}</p>}
                    {finding.dead_calls.length > 0 && (
                      <>
                        <p>Dead calls to delete</p>
                        <ul className="flag-finding__dead">
                          {finding.dead_calls.map(({ source, target }) => (
                            <li key={JSON.stringify([source, target])} title={`${source} → ${target}`}>
                              <code>{source.split(":").at(-1)} → {target.split(":").at(-1)}</code>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
