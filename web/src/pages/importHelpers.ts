import type { ImportRequest, ImportStatus, RepoStatus } from "../types";

export interface ImportFields {
  url: string;
  subdir: string;
  maxCommits: string;
}

type Validation =
  | { body: ImportRequest }
  | { field: keyof ImportFields; message: string };

export function validateImport(fields: ImportFields): Validation {
  const url = fields.url.trim();
  const match = /^https:\/\/github\.com\/[a-z0-9-]+\/([a-z0-9_.-]+)\/?$/i.exec(url);
  const repoName = match?.[1].replace(/\.git$/i, "");
  if (!repoName || repoName === "." || repoName === "..") {
    return { field: "url", message: "Enter a public GitHub repository URL like https://github.com/owner/repo." };
  }

  const subdir = fields.subdir.trim();
  if (subdir.startsWith("/") || subdir.includes("\\") || /^[a-z]:/i.test(subdir) || subdir.split("/").includes("..")) {
    return { field: "subdir", message: "Enter a folder inside the repository without any .. segments, such as api/." };
  }

  const count = fields.maxCommits.trim();
  const max_commits = Number(count);
  if (!/^\d+$/.test(count) || max_commits < 1 || max_commits > 200) {
    return { field: "maxCommits", message: "Enter a whole number from 1 to 200." };
  }

  return { body: { url, subdir, max_commits } };
}

export const importSteps = [
  { status: "queued", label: "Queued" },
  { status: "cloning", label: "Cloning" },
  { status: "analyzing", label: "Analyzing" },
  { status: "ready", label: "Ready" },
] as const;

export function importProgress(initial: RepoStatus, update?: ImportStatus) {
  const status = update?.status ?? initial;
  const step = importSteps.findIndex((item) => item.status === status);
  const total = update?.total ?? 0;
  const current = update?.current ?? 0;
  const progress = total > 0 ? { current, total } : null;
  let text = update?.message || importSteps[step]?.label || "Analysis could not be completed.";

  if (status === "analyzing" && progress) text = `Analyzing commit ${current} of ${total}`;
  if (status === "error" && update?.error) text = update.error;

  return { step, text, progress, warning: update?.warning ?? null };
}

export function displaySubdir(subdir: string) {
  return `${subdir.replace(/\/+$/, "")}/`;
}
