import { AppLink } from "../AppLink";
import { repoPath } from "../router";
import type { LandingVariant } from "../view";
import type { ImportFields } from "./importHelpers";

export const demoRepoPath = repoPath("Flagsmith__flagsmith");
export type FormError = { field?: keyof ImportFields; message: string };

export function LandingImport({ variant, hosted, fields, formError, busy, submitting, onEdit, onSubmit, onExample }: {
  variant: LandingVariant | null;
  hosted: boolean;
  fields: ImportFields;
  formError: FormError | null;
  busy: boolean;
  submitting: boolean;
  onEdit: (field: keyof ImportFields, value: string) => void;
  onSubmit: () => void;
  onExample: () => void;
}) {
  const submitButton = (
    <button type="submit" className="btn btn--primary">
      {submitting ? "Starting analysis…" : variant === "c" ? "Analyze" : "Analyze repository"}
    </button>
  );

  return (
    <section className={variant === "c" ? "import-card" : "card import-card"} aria-labelledby="import-title">
      <h2 className={variant === "c" ? "landing-preview__sr-only" : undefined} id="import-title">
        Analyze a GitHub repo
      </h2>
      <form noValidate onSubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(); }}>
        <fieldset disabled={busy}>
          <div className="field import-card__url">
            <label className="field__label" htmlFor="import-url">GitHub repository URL</label>
            <input
              id="import-url" className="input" type="url" required
              placeholder="https://github.com/owner/repo" value={fields.url}
              aria-invalid={formError?.field === "url"}
              aria-describedby={formError?.field === "url" ? "import-error" : undefined}
              onChange={(event) => onEdit("url", event.target.value)}
            />
          </div>
          {variant === "c" && submitButton}
          <div className="field import-card__subdir">
            <label className="field__label" htmlFor="import-subdir">Subfolder (optional)</label>
            <input
              id="import-subdir" className="input" type="text" value={fields.subdir}
              placeholder={variant === "b" ? "e.g. api/" : undefined}
              aria-invalid={formError?.field === "subdir"}
              aria-describedby={formError?.field === "subdir" ? "subdir-hint import-error" : "subdir-hint"}
              onChange={(event) => onEdit("subdir", event.target.value)}
            />
            <p className={variant === "b" || variant === "c" ? "landing-preview__sr-only" : "muted field__hint"} id="subdir-hint">
              e.g. api/ — only Python under this folder is analyzed
            </p>
          </div>
          <div className="field import-card__count">
            <label className="field__label" htmlFor="import-maxCommits">
              {variant === "c" ? "Recent commits" : "Number of recent commits"}
            </label>
            <input
              id="import-maxCommits" className="input" type="number" min="1" max="200" step="1" required
              value={fields.maxCommits}
              aria-invalid={formError?.field === "maxCommits"}
              aria-describedby={formError?.field === "maxCommits" ? "import-error" : undefined}
              onChange={(event) => onEdit("maxCommits", event.target.value)}
            />
          </div>
          {formError && <p className="field" id="import-error" role="alert">{formError.message}</p>}
          {variant !== "c" && submitButton}
        </fieldset>
      </form>
      {hosted && (
        <p className="muted field__hint">
          Imports and new commits on this demo are temporary and reset when the server restarts.
          The Flagsmith/flagsmith example is always available.
        </p>
      )}
      {variant !== "a" && (
        <div className="import-examples">
          <h3>Try an example</h3>
          <div className="import-examples__actions">
            {hosted || variant ? (
              <AppLink href={demoRepoPath} className="btn btn--sm">
                {variant === "c" ? "Flagsmith/flagsmith · api/" : "Flagsmith/flagsmith (api/)"}
              </AppLink>
            ) : (
              <button type="button" className="btn btn--sm" disabled={busy} onClick={onExample}>
                Flagsmith/flagsmith (api/)
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
