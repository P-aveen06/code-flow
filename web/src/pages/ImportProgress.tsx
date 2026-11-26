import { useEffect, useRef } from "react";
import { AppLink } from "../AppLink";
import { repoPath } from "../router";
import type { ImportResponse, ImportStatus } from "../types";
import { importProgress, importSteps } from "./importHelpers";

export function ImportProgress({ job, update, pollError, onRetry }: {
  job: ImportResponse;
  update?: ImportStatus;
  pollError: string | null;
  onRetry: () => void;
}) {
  const { step, text, progress, warning } = importProgress(job.status, update);
  const failed = pollError || update?.status === "error";
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    card.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <section ref={card} className="card import-progress" aria-labelledby="import-progress-title">
      <h2 id="import-progress-title">Import progress</h2>
      <ol className="import-steps" aria-label="Import steps">
        {importSteps.map(({ status, label }, index) => (
          <li key={status} aria-current={index === step ? "step" : undefined} data-complete={index < step}>
            {label}
          </li>
        ))}
      </ol>
      {failed ? (
        <p role="alert">{pollError || text}</p>
      ) : (
        <p role="status">{text}</p>
      )}
      {progress && <progress aria-label="Commits analyzed" value={progress.current} max={progress.total} />}
      {update && <p className="muted">Elapsed time {update.seconds.toFixed(1)} seconds</p>}
      {warning && <p className="state-warning" role="status">{warning}</p>}
      {failed && <button type="button" className="btn" onClick={onRetry}>Try again</button>}
      {update?.status === "ready" && <AppLink href={repoPath(job.id)} className="btn btn--primary">Open</AppLink>}
    </section>
  );
}
