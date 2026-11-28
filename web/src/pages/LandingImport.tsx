import type { ImportFields } from "./importHelpers";

export type FormError = { field?: keyof ImportFields; message: string };

export function LandingImport({ hosted, fields, formError, busy, submitting, onEdit, onSubmit }: {
  hosted: boolean;
  fields: ImportFields;
  formError: FormError | null;
  busy: boolean;
  submitting: boolean;
  onEdit: (field: keyof ImportFields, value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <section className="card import-card" aria-labelledby="import-title">
      <h2 id="import-title">Analyze a GitHub repo</h2>
      <form noValidate onSubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(); }}>
        <fieldset disabled={busy}>
          <div className="import-card__url">
            <label className="field__label" htmlFor="import-url">GitHub repository URL</label>
            <input
              id="import-url" className="input" type="url" required
              placeholder="https://github.com/owner/repo" value={fields.url}
              aria-invalid={formError?.field === "url"}
              aria-describedby={formError?.field === "url" ? "import-error" : undefined}
              onChange={(event) => onEdit("url", event.target.value)}
            />
          </div>
          <div>
            <label className="field__label" htmlFor="import-subdir">Subfolder (optional)</label>
            <input
              id="import-subdir" className="input" type="text" value={fields.subdir}
              aria-invalid={formError?.field === "subdir"}
              aria-describedby={formError?.field === "subdir" ? "subdir-hint import-error" : "subdir-hint"}
              onChange={(event) => onEdit("subdir", event.target.value)}
            />
            <p className="muted field__hint" id="subdir-hint">
              e.g. api/ — only Python under this folder is analyzed
            </p>
          </div>
          <div>
            <label className="field__label" htmlFor="import-maxCommits">Number of recent commits</label>
            <input
              id="import-maxCommits" className="input" type="number" min="1" max="200" step="1" required
              value={fields.maxCommits}
              aria-invalid={formError?.field === "maxCommits"}
              aria-describedby={formError?.field === "maxCommits" ? "import-error" : undefined}
              onChange={(event) => onEdit("maxCommits", event.target.value)}
            />
          </div>
          {formError && <p id="import-error" role="alert">{formError.message}</p>}
          <button type="submit" className="btn btn--primary">
            {submitting ? "Starting analysis…" : "Analyze repository"}
          </button>
        </fieldset>
      </form>
      {hosted && (
        <p className="muted field__hint">
          Imports and new commits on this demo are temporary and reset when the server restarts.
          The Flagsmith/flagsmith example is always available.
        </p>
      )}
    </section>
  );
}
