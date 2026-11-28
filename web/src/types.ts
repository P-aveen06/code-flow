export type RepoStatus = "queued" | "cloning" | "analyzing" | "ready" | "error";

export interface Repo {
  id: string;
  name: string;
  url: string | null;
  subdir: string | null;
  branch: string;
  commit_count: number;
  status: RepoStatus;
  message: string;
  warning: string | null;
  // Private repos are visible only to the GitHub user who imported them.
  visibility?: "public" | "private";
}

export interface ImportRequest {
  url: string;
  subdir: string;
  max_commits: number;
}

export interface PickedImportRequest {
  github_repo_id: number;
  installation_id: number;
  // The default branch when left out.
  branch?: string;
  subdir: string;
  max_commits: number;
}

export type Me =
  | { configured: boolean; signed_in: false }
  | { configured: true; signed_in: true; login: string; avatar_url: string; install_url: string };

export interface GitHubRepoChoice {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  installation_id: number;
}

export interface GitHubBranches {
  repo: GitHubRepoChoice;
  // The default branch comes first.
  branches: string[];
}

export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface GitHubCommitList {
  branch: string;
  // The count actually used: the server's import cap can lower the requested one.
  limit: number;
  commits: GitHubCommit[];
}

// The branches of an imported GitHub repository, for the branch switch in a flow view.
export interface RepoBranches {
  repo: string;
  full_name: string;
  default_branch: string;
  // This import's branch, or the default branch.
  current_branch: string;
  // The default branch first, then by name, at most 100.
  branches: string[];
  // Imports of the same repository and folder that this viewer can see, one per analyzed branch.
  analyzed: { branch: string; id: string; status: RepoStatus }[];
}

export interface ImportResponse {
  id: string;
  status: RepoStatus;
}

export interface ImportStatus extends ImportResponse {
  name: string;
  message: string;
  current: number | null;
  total: number | null;
  warning: string | null;
  error: string | null;
  new_commits: number | null;
  seconds: number;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  date: string;
  message: string;
}

export interface DiffStats {
  nodes_added: number;
  nodes_removed: number;
  nodes_changed: number;
  edges_added: number;
  edges_removed: number;
}

export interface TimelineCommit extends Commit {
  stats: DiffStats;
  summary: string;
}

export interface CommitList {
  repo: string;
  branch: string;
  commits: TimelineCommit[];
}

export type NodeKind = "function" | "method" | "class" | "module" | "external";

export interface Guard {
  flag: string;
  when: "on" | "off";
}

export type FlagStatus = "orphan" | "live" | "off" | "unused" | "unknown";

export interface FlagCheck {
  file: string;
  line: number;
  function: string;
  call: string;
}

export interface FlagFinding {
  name: string;
  status: FlagStatus;
  enabled: boolean | null;
  value: string | number | boolean | null;
  in_flagsmith: boolean;
  checks: FlagCheck[];
  guarded_edges: (EdgeEndpoints & { when: Guard["when"]; live: boolean | null })[];
  stale: boolean;
  stale_reason: string | null;
  dead_calls: EdgeEndpoints[];
}

export interface RepoFlags {
  repo: string;
  sha: string;
  flagsmith: {
    connected: boolean;
    environment: string | null;
    fetched_at: string | null;
    error: string | null;
  };
  flags: FlagFinding[];
}

interface EdgeEndpoints {
  source: string;
  target: string;
}

interface NodeLocation {
  id: string;
  name: string;
  module: string;
  kind: NodeKind;
  file: string;
  line: number;
  end_line: number;
}

export interface GraphSnapshot {
  schema: "code-flow/graph@1";
  repo: string;
  commit: Commit;
  nodes: (NodeLocation & { body_hash: string })[];
  edges: (EdgeEndpoints & { kind: "call"; line: number; guard: Guard | null })[];
  flags: (FlagCheck & { name: string })[];
}

interface AddedRemoved<T> {
  added: T[];
  removed: T[];
}

export interface GraphDiff {
  schema: "code-flow/diff@1";
  base: string;
  head: string;
  nodes: AddedRemoved<string> & { changed: string[] };
  edges: AddedRemoved<EdgeEndpoints>;
  flags: AddedRemoved<string>;
  stats: DiffStats;
}

export type EdgeStatus = "added" | "removed" | "context";
export type NodeStatus = EdgeStatus | "changed";

interface RevisionPresence {
  in_base: boolean;
  in_head: boolean;
}

export interface OverlayNode extends NodeLocation, RevisionPresence {
  qualname: string;
  status: NodeStatus;
  lines_added: number | null;
  lines_removed: number | null;
}

export interface OverlayEdge extends EdgeEndpoints, RevisionPresence {
  status: EdgeStatus;
  guard: Guard | null;
}

export interface DiffViewModel {
  base: string;
  head: string;
  summary: string;
  flow_depth: number;
  long_flow: boolean;
  diff: GraphDiff;
  nodes: OverlayNode[];
  edges: OverlayEdge[];
}

export interface CodeSnippet {
  sha: string;
  file: string;
  start: number;
  end: number;
  lines: { number: number; text: string }[];
}

export interface LineDiffRow {
  kind: "context" | "added" | "removed";
  base_line: number | null;
  head_line: number | null;
  text: string;
}

export interface FunctionDiff {
  node: string;
  base: string;
  head: string;
  file: string;
  status: NodeStatus;
  lines_added: number;
  lines_removed: number;
  rows: LineDiffRow[];
}
